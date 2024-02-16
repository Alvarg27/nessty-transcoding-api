const express = require("express");
const { transcoderVideo } = require("../controllers/transcoder");
const fileUploader = require("../middleware/fileUploader");
const router = express.Router();

router.post("/new", fileUploader, transcoderVideo);

module.exports = router;
