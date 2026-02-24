declare module "noise-handshake/noise.js" {
  export default class Noise {
    constructor(pattern: string, initiator: boolean, staticKeypair: { publicKey: Buffer; secretKey: Buffer });
    initialise(prologue: Buffer, remoteStatic?: Buffer): void;
    send(payload?: Buffer): Buffer;
    recv(message: Buffer): Buffer;
    readonly complete: boolean;
    readonly tx: Buffer;
    readonly rx: Buffer;
    readonly rs: Buffer;
  }
}

declare module "noise-handshake/cipher.js" {
  export default class Cipher {
    constructor(key: Buffer);
    encrypt(data: Buffer): Buffer;
    decrypt(data: Buffer): Buffer;
  }
}
