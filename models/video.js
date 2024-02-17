const mongoose = require("mongoose");
const Schema = mongoose.Schema;
const { connection1, connection2 } = require("../helpers/initMongoDb");

const VideoSchema = Schema({
  organization: { type: Schema.Types.ObjectId, ref: "organization" },
  name: { type: String },
  original_filename: { type: String },
  streams: [{ type: String }],
  status: {
    type: String,
    enum: [
      "requested",
      "uploading",
      "processing",
      "unpublished",
      "failed",
      "active",
    ],
  },
  processing_start: { type: Date },
  processing_end: { type: Date },
  upload_start: { type: Date },
  upload_end: { type: Date },
  upload_progress: { type: Number },
  processing_progress: { type: Number },
  duration: { type: Number },
  updated: { type: Date },
  created: { type: Date },
});

const VideoProduction = connection1.model("video", VideoSchema);
const VideoSandbox = connection2.model("video", VideoSchema);

module.exports = { VideoProduction, VideoSandbox };
