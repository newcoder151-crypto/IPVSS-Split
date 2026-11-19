/** A failed send. permanent = true: retrying cannot help (wrong key, invalid number, rejected sender) - the message is marked failed at once. */
class SendError extends Error {
  constructor(message, permanent = false) {
    super(message);
    this.name = "SendError";
    this.permanent = permanent;
  }
}
module.exports = { SendError };
