import type { Signals } from "./signals";
import type { PersistentServiceStorage } from "./storage";

export type OptionValue = string | number | boolean | null;

declare const optionObjects: unique symbol;

export type OptionObjects<Identifier extends string, Shape> = {
  readonly [optionObjects]: {
    readonly identifier: Identifier;
    readonly shape: Shape;
  };
};

export interface OptionSchemas {}

type UnionToIntersection<Union> = (
  Union extends unknown ? (value: Union) => void : never
) extends (value: infer Intersection) => void ? Intersection : never;
type EffectiveSchema = UnionToIntersection<
  OptionSchemas[keyof OptionSchemas]
>;
type AnyObjects = OptionObjects<string, unknown>;
type StringKey<Shape> = Extract<keyof Shape, string>;
type ScalarName<Shape> = {
  [Name in StringKey<Shape>]: Shape[Name] extends OptionValue ? Name : never;
}[StringKey<Shape>];
type CategoryName<Shape> = {
  [Name in StringKey<Shape>]: Shape[Name] extends AnyObjects ? Name : never;
}[StringKey<Shape>];
type ObjectIdentifier<Definition extends AnyObjects> =
  Definition[typeof optionObjects]["identifier"];
type ObjectShape<Definition extends AnyObjects> =
  Definition[typeof optionObjects]["shape"];

export interface OptionRoot<Schema> {
  cat<Name extends CategoryName<Schema>>(
    name: Name,
  ): OptionCategory<Extract<Schema[Name], AnyObjects>>;
}

export interface OptionCategory<Definition extends AnyObjects> {
  obj(
    identifier: ObjectIdentifier<Definition>,
  ): OptionObject<ObjectShape<Definition>>;
}

export interface OptionObject<Shape> {
  get<Name extends ScalarName<Shape>>(name: Name): Shape[Name] | undefined;
  set<Name extends ScalarName<Shape>>(
    name: Name,
    value: Shape[Name],
  ): Promise<void>;
  unset<Name extends ScalarName<Shape>>(name: Name): Promise<void>;
  observe<Name extends ScalarName<Shape>>(
    name: Name,
    listener: (value: Shape[Name] | undefined) => unknown,
  ): () => void;
  cat<Name extends CategoryName<Shape>>(
    name: Name,
  ): OptionCategory<Extract<Shape[Name], AnyObjects>>;
}

export type Options<Schema = EffectiveSchema> = OptionRoot<Schema>;

interface OptionChange {
  readonly object: string;
  readonly property: string;
  readonly value: OptionValue | undefined;
}

interface RuntimeRoot {
  cat(name: string): RuntimeCategory;
}

interface RuntimeCategory {
  obj(identifier: string): RuntimeObject;
}

interface RuntimeObject {
  get(name: string): OptionValue | undefined;
  set(name: string, value: OptionValue): Promise<void>;
  unset(name: string): Promise<void>;
  observe(
    name: string,
    listener: (value: OptionValue | undefined) => unknown,
  ): () => void;
  cat(name: string): RuntimeCategory;
}

export async function createOptions<Schema = EffectiveSchema>(
  storage: PersistentServiceStorage,
  signals: Signals,
): Promise<Options<Schema>> {
  const persisted = storage.kv<unknown>();
  const values = new Map<string, OptionValue>();

  for (const [key, value] of await persisted.entries()) {
    if (isOptionValue(value)) values.set(key, value);
    else await persisted.delete(key);
  }

  const changes = signals.channel<OptionChange>({}, "changes");

  function category(path: string): RuntimeCategory {
    return {
      obj(identifier) {
        return object(`${path}/${encodeIdentifier(identifier)}`);
      },
    };
  }

  function object(path: string): RuntimeObject {
    return {
      get(name) {
        return values.get(propertyKey(path, name));
      },
      async set(name, value) {
        const property = validateName(name, "property");
        if (!isOptionValue(value)) {
          throw new TypeError("Options support only scalar values.");
        }

        const key = `${path}.${property}`;
        if (Object.is(values.get(key), value)) return;
        await persisted.put(key, value);
        values.set(key, value);
        changes.publish({ object: path, property, value });
      },
      async unset(name) {
        const property = validateName(name, "property");
        const key = `${path}.${property}`;
        if (!values.has(key)) return;
        await persisted.delete(key);
        values.delete(key);
        changes.publish({ object: path, property, value: undefined });
      },
      observe(name, listener) {
        const property = validateName(name, "property");
        return changes.subscribe((change) => {
          if (change.object === path && change.property === property) {
            listener(change.value);
          }
        });
      },
      cat(name) {
        return category(`${path}/${validateName(name, "category")}`);
      },
    };
  }

  const root: RuntimeRoot = {
    cat(name) {
      return category(validateName(name, "category"));
    },
  };
  return root as Options<Schema>;
}

function propertyKey(path: string, name: string): string {
  return `${path}.${validateName(name, "property")}`;
}

function validateName(name: string, kind: "category" | "property"): string {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.includes("/") ||
    name.includes(".")
  ) {
    throw new TypeError(`Option ${kind} names must be nonempty path segments.`);
  }
  return name;
}

function encodeIdentifier(identifier: string): string {
  if (typeof identifier !== "string" || identifier.length === 0) {
    throw new TypeError("Option object identifiers must be nonempty strings.");
  }
  return encodeURIComponent(identifier).replaceAll(".", "%2E");
}

function isOptionValue(value: unknown): value is OptionValue {
  return value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean";
}
