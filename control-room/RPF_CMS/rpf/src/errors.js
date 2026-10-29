class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (m) => new HttpError(400, m);
const unauthorized = (m = 'authentication required') => new HttpError(401, m);
const forbidden = (m = 'not allowed') => new HttpError(403, m);
const notFound = (m = 'not found') => new HttpError(404, m);
const conflict = (m) => new HttpError(409, m);

/** Wrap async route handlers so rejections reach the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict, wrap };
