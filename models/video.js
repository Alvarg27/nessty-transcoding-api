const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const SessionTokenSchema = Schema({
  organization: { type: String },
  status: {
    type: String,
    enum: ["uploading", "processing", "unpublished", "active"],
  },
  account: { type: Schema.Types.ObjectId, ref: "account" },
  upload_progress: { type: Number },
  processing_progress: { type: Number },
  updated: { type: Date },
  created: { type: Date },
});

const SessionToken = mongoose.model("session_token", SessionTokenSchema);
module.exports = SessionToken;
