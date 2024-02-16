const Multer = require("multer");
const util = require("util");
const path = require("path");
const createHttpError = require("http-errors");

const fileUploader = Multer({
  storage: Multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowedFileTypes = [".mp4"];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    if (allowedFileTypes.includes(fileExtension)) {
      cb(null, true);
    } else {
      throw createHttpError.BadRequest("Only .mp4 files are allowed.");
    }
  },
}).single("file");

let fileUploaderMiddleware = util.promisify(fileUploader);
module.exports = fileUploaderMiddleware;
