import { SignJWT, jwtVerify } from "jose";

const encoder = new TextEncoder();

export async function signJWT(secret: string, expiration = "1d") {
  return new SignJWT({ sub: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(encoder.encode(secret));
}

export async function verifyJWT(token: string, secret: string) {
  return jwtVerify(token, encoder.encode(secret));
}
