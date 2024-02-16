const createError = require("http-errors");
const { default: axios } = require("axios");
const jose = require("jose");
const moment = require("moment");

const tokenAuth = async (authHeader, allowedScope) => {
  // RETRIEVE HEADERS
  if (!authHeader) {
    throw createError.Unauthorized();
  }
  const bearerToken = authHeader.split(" ");
  const token = bearerToken[1];
  const [encodedHeader] = token.split(".");
  // RETRIEVE PUBLIC KEY

  const response = await axios.get(
    `https://id.tectify.io/o/${process.env.TENANT_ID}/oauth/jwks`
  );

  const jwks = response.data;

  // KEY SIGNING ALGORITHM
  const alg = "RS256";

  // FIND JWK
  const matchingKey = jwks.keys.find(
    (k) =>
      k.kid === JSON.parse(Buffer.from(encodedHeader, "base64").toString()).kid
  );

  // IMPORT JWK
  const publicKey = await jose.importJWK(matchingKey, alg);

  // VERIFY JWT SIGNATURE

  const { payload } = await jose.jwtVerify(token, publicKey);

  //VALIDATE AUDIENCE
  if (!payload.aud) {
    throw createError.Unauthorized();
  }

  if (!payload.aud.includes(process.env.API_IDENTIFIER)) {
    throw createError.Unauthorized();
  }

  // VALIDATE TOKEN EXPIRATION
  //if (payload?.exp && payload?.exp <= Math.floor(Date.now() / 1000)) {
  //  throw createError.Unauthorized();
  //}
  // VALIDATE TOKEN EXPIRATION VIA MOMENT

  if (payload?.exp && moment.unix(payload.exp).isBefore(moment())) {
    throw createError.Unauthorized("ERR_JWT_EXPIRED");
  }
  if (!payload?.scope) {
    // VALIDATE SCOPE
    throw createError.Unauthorized();
  }
  const scope = payload.scope.split(" ");

  if (
    scope.findIndex(
      (x) =>
        process.env.API_IDENTIFIER +
          "/" +
          process.env.TENANT_ID +
          "/" +
          allowedScope ===
          x ||
        (allowedScope === "profile" && allowedScope === x)
    ) < 0
  ) {
    throw createError.Unauthorized();
  }

  // RETRIEVE SUBJECT

  if (!payload?.sub) {
    throw createError.Unauthorized();
  }

  return payload.sub;
};

module.exports = tokenAuth;
