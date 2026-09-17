const ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

function isValidId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

module.exports = { isValidId };
