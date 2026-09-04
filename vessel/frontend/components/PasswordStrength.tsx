import type { ZxcvbnFactory } from "@zxcvbn-ts/core";
import { For, createMemo, createResource } from "solid-js";
import "./PasswordStrength.css";

const passwordStrengthLabels = ["Very weak", "Weak", "Fair", "Strong", "Very strong"];

async function initializePasswords(): Promise<ZxcvbnFactory> {
  const [{ ZxcvbnFactory }, common, english] = await Promise.all([
    import("@zxcvbn-ts/core"),
    import("@zxcvbn-ts/language-common"),
    import("@zxcvbn-ts/language-en"),
  ]);
  return new ZxcvbnFactory({
    dictionary: { ...common.dictionary, ...english.dictionary },
    graphs: common.adjacencyGraphs,
    translations: english.translations,
  });
}

export function PasswordStrength(props: { password: string }) {
  const [passwords] = createResource(initializePasswords);
  const current = createMemo(() => {
    if (props.password.length === 0) return { level: 0, label: "Enter a password" };
    if (passwords.loading) return { level: 0, label: "Checking…" };
    if (passwords.error !== undefined) return { level: 0, label: "Unavailable" };
    const checker = passwords();
    if (checker === undefined) return { level: 0, label: "Unavailable" };
    const score = checker.check(props.password).score;
    return {
      level: Math.max(1, score),
      label: passwordStrengthLabels[score] ?? "Unavailable",
    };
  });
  const description = () => {
    if (current().label === "Checking…") return "Checking password strength…";
    if (current().label === "Unavailable") return "Password strength unavailable.";
    return `Password strength: ${current().label}`;
  };

  return (
    <div>
      <div
        class="password-strength"
        data-level={current().level}
        role="meter"
        aria-label={description()}
        aria-busy={passwords.loading}
        aria-valuemin="0"
        aria-valuemax="4"
        aria-valuenow={current().level}
      >
        <For each={[1, 2, 3, 4]}>
          {(level) => <span classList={{ active: level <= current().level }} />}
        </For>
      </div>
      <small>{description()}</small>
    </div>
  );
}
