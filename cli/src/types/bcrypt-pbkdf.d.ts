declare module "bcrypt-pbkdf" {
  export function pbkdf(
    pass: Buffer, passLen: number,
    salt: Buffer, saltLen: number,
    key: Buffer, keyLen: number,
    rounds: number,
  ): number;
}
