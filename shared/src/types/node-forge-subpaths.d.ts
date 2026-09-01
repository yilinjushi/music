declare module "node-forge/lib/forge.js" {
  const forge: typeof import("node-forge");
  export default forge;
}

declare module "node-forge/lib/aes.js" {}
declare module "node-forge/lib/rsa.js" {}
declare module "node-forge/lib/md5.js" {}
