import { base64ToBytes, bytesToBase64 } from "@c/base64";

// The credentials ceremony, which is a Window interface and so cannot run in the
// Worker holding the secrets. What crosses to it is the pseudo-random function's
// output, derived again at each unlock and kept nowhere.

/** What enrolment produces: the credential to ask again, and the secret it derived. */
interface EnrolledAuthenticator {
  credentialId: string;
  salt: string;
  secret: string;
}

const relyingPartyName = "brochain";
const saltLength = 32;
const challengeLength = 32;
const userHandleLength = 32;
const unsupportedAuthenticator = new Error("This device cannot unlock accounts.");
const declinedAuthenticator = new Error("This device did not confirm it is you.");

// An authenticator which evaluates the function is what this needs, and a client
// which says whether it does is asked rather than assumed. The ceremony itself
// remains the final word, because only it involves the authenticator.
export async function supportsAuthenticator(): Promise<boolean> {
  if (globalThis.PublicKeyCredential === undefined) return false;
  if (!await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()) return false;
  if (typeof PublicKeyCredential.getClientCapabilities !== "function") return true;

  const capabilities = await PublicKeyCredential.getClientCapabilities()
    .catch(() => undefined);
  return capabilities === undefined || capabilities["extension:prf"] === true;
}

export async function createAuthenticator(username: string): Promise<EnrolledAuthenticator> {
  const salt = randomBytes(saltLength);
  const credential = await ceremony(async () =>
    await navigator.credentials.create({
      publicKey: {
        rp: { name: relyingPartyName },
        user: { id: randomBytes(userHandleLength), name: username, displayName: username },
        challenge: randomBytes(challengeLength),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          // The function is bound to the credential as it is made, and an
          // authenticator binds it to a passkey it keeps rather than to a
          // credential it hands back, so a discoverable one is what to ask for.
          residentKey: "required",
          userVerification: "required",
        },
        attestation: "none",
        extensions: { prf: { eval: { first: salt } } },
      },
    }));
  const credentialId = bytesToBase64(new Uint8Array(credential.rawId));
  const evaluated = credential.getClientExtensionResults().prf?.results;

  // Creating the credential is not asking: a client which evaluates the function
  // while making one has already answered, and a client which evaluates it only
  // when the credential is used answers when it is used. Using it is therefore
  // what says whether this device can, at the cost of a second confirmation.
  const secret = evaluated === undefined
    ? await openAuthenticator(credentialId, bytesToBase64(salt))
    : secretOf(evaluated.first);

  return { credentialId, salt: bytesToBase64(salt), secret };
}

export async function openAuthenticator(credentialId: string, salt: string): Promise<string> {
  const assertion = await ceremony(async () =>
    await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(challengeLength),
        allowCredentials: [{ type: "public-key", id: base64ToBytes(credentialId) }],
        userVerification: "required",
        extensions: { prf: { eval: { first: base64ToBytes(salt) } } },
      },
    }));
  const results = assertion.getClientExtensionResults().prf?.results;

  if (results === undefined) throw unsupportedAuthenticator;

  return secretOf(results.first);
}

// A declined, dismissed or timed-out ceremony all reach the reader as one thing:
// the device did not confirm them, and the password is still there.
async function ceremony(
  perform: () => Promise<Credential | null>,
): Promise<PublicKeyCredential> {
  let credential: Credential | null;

  try {
    credential = await perform();
  } catch {
    throw declinedAuthenticator;
  }

  if (!(credential instanceof PublicKeyCredential)) throw declinedAuthenticator;

  return credential;
}

// The credentials interfaces take a buffer whose own bytes are theirs alone.
function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(length)));
}

function secretOf(value: BufferSource): string {
  return bytesToBase64(
    ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array(value),
  );
}
