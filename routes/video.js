const express = require("express");
const { transcoderVideo } = require("../controllers/transcoder");
const router = express.Router();

router.post("/process/:videoId", transcoderVideo);

module.exports = router;
