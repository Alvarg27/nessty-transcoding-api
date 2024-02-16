const createError = require("http-errors");
const tokenAuth = require("../helpers/authorization/tokenAuth");
const Employee = require("../models/employee");
const Account = require("../models/account");
const Roles = require("../data/roles");

const authorize = ({ scope, validate_organization, ignoreAccount }) => {
  return async (req, res, next) => {
    try {
      // RETRIEVE HEADERS
      if (!req.headers["authorization"]) {
        throw createError.Unauthorized();
      }
      const authHeader = req.headers["authorization"];

      // VALIDATE TOKEN FOR AUTHENTICITY, EXPIRATION, AND PROFILE SCOPE
      req.userId = await tokenAuth(authHeader, "profile");

      // RETRIEVE ACCOUNT
      const account = await Account.findOne({
        user: req.userId,
        online: true,
      })
        .select("user firstName lastName stripe_customer email")
        .lean();

      if (!account && !ignoreAccount) {
        throw createError.Unauthorized();
      }
      if (!ignoreAccount) {
        req.account = account;
        req.accountId = account?._id?.toString();
      }

      //////////////////////////////////
      // AUTHORIZATION FOR ORGANIZATION GRAINED SCOPES
      /////////////////////////////////
      if (validate_organization) {
        // RETRIEVE EMPLOYEE
        const employee = await Employee.findOne({
          organization: req.params.organizationId,
          account: account._id,
        }).lean();
        if (!employee) {
          throw createError.Unauthorized();
        }
        // LIST USER PERMISSION INSIDE ORGANIZATION
        const permissions = employee?.roles?.reduce((acc, x) => {
          const role = Roles.find((y) => x === y._id);
          return [...acc, ...role.permissions];
        }, []);

        if (permissions.findIndex((x) => scope === x) < 0) {
          throw createError.Unauthorized();
        }

        req.employeeId = employee._id;
      }

      next();
    } catch (error) {
      console.log(error);
      next(error);
    }
  };
};

module.exports = authorize;
