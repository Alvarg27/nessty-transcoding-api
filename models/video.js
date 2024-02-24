const mongoose = require("mongoose");
const Schema = mongoose.Schema;
const { connection1, connection2 } = require("../helpers/initMongoDb");

const VideoSchema = Schema({
  organization: { type: Schema.Types.ObjectId, ref: "organization" },
  name: { type: String },
  title: { type: String },
  description: { type: String },
  streams: [{ type: String }],
  type: { type: String },
  input_dimensions: {
    height: { type: Number },
    width: { type: Number },
  },
  aspect_ratio: { type: Number },
  input_bitrate: { type: Number },
  input_codec: { type: String },
  input_avg_frame_rate: { type: String },
  status: {
    type: String,
    enum: [
      "requested",
      "uploading",
      "pending_processing",
      "processing",
      "complete",
      "failed",
    ],
  },
  publishing_status: {
    type: String,
    enum: ["draft", "published"],
    default: "draft",
  },
  signed_url_data: {
    url: { type: String },
    fields: {
      key: { type: String },
      "x-goog-date": { type: String },
      "x-goog-credential": { type: String },
      "x-goog-algorithm": { type: String },
      policy: { type: String },
      "x-goog-signature": { type: String },
    },
  },
  processing_start: { type: Date },
  processing_end: { type: Date },
  upload_progress: { type: Number },
  processing_progress: { type: Number },
  duration: { type: Number },
  updated: { type: Date },
  created: { type: Date },
  object: { type: String, enum: ["video"], default: "video" },
});

const VideoProduction = connection1.model("video", VideoSchema);
const VideoSandbox = connection2.model("video", VideoSchema);

module.exports = { VideoProduction, VideoSandbox };
