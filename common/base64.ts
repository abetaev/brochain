export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";

  for (let offset = 0; offset < bytes.byteLength; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }

  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
