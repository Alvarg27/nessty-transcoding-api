const createError = require("http-errors");
const crypto = require("crypto");

const verifyJwt = async (jwt, publicKey) => {
  const tokenElements = jwt.split(".");
  const encodedHeader = tokenElements[0];
  const encodedPayload = tokenElements[1];
  const encodedSignature = tokenElements[2];

  const verify = crypto.createVerify("sha256");
  verify.update(encodedHeader + "." + encodedPayload);
  verify.end();
  const key = {
    key: publicKey.pem,
  };

  const verified = verify.verify(key, Buffer.from(encodedSignature, "base64"));
  if (!verified) {
    throw createError.Unauthorized("Invalid signature");
  }
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64").toString());
  const header = JSON.parse(Buffer.from(encodedHeader, "base64").toString());
  return { header, payload };
};
module.exports = verifyJwt;
