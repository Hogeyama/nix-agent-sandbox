///| Error type for process operations.
pub(all) suberror ProcessError {
  ProcessError(String)
}

///| Execute a command and capture its stdout output.
/// Returns the output as a string (trailing newline stripped).
pub fn capture_output(cmd : String) -> String {
  let cmd_bytes = string_to_cstr(cmd)
  let result_bytes = capture_output_ffi(cmd_bytes)
  let output = cstr_to_string(result_bytes)
  // Strip trailing newline
  if output.length() > 0 && output[output.length() - 1] == '\n' {
    output[0:output.length() - 1].to_string()
  } else {
    output
  }
}

///| Execute a command with inherited stdio (interactive).
/// Returns the exit code.
pub fn exec(cmd : String) -> Int {
  let cmd_bytes = string_to_cstr(cmd)
  exec_ffi(cmd_bytes)
}

///| Execute a command and check if it succeeds (exit code 0).
pub fn exec_ok(cmd : String) -> Bool {
  exec(cmd) == 0
}

// ---- String <-> Bytes (UTF-8 with null terminator) ----

///| Convert a MoonBit String to a null-terminated UTF-8 Bytes.
fn string_to_cstr(s : String) -> Bytes {
  let arr : Array[Byte] = []
  let len = s.length()
  let mut i = 0
  while i < len {
    let mut c = s.code_unit_at(i).to_int()
    // Handle surrogate pairs
    if 0xD800 <= c && c <= 0xDBFF && i + 1 < len {
      let hi = c - 0xD800
      i = i + 1
      let lo = s.code_unit_at(i).to_int() - 0xDC00
      c = (hi << 10) + lo + 0x10000
    }
    if c < 0x80 {
      arr.push(c.to_byte())
    } else if c < 0x800 {
      arr.push((0xC0 + (c >> 6)).to_byte())
      arr.push((0x80 + (c & 0x3F)).to_byte())
    } else if c < 0x10000 {
      arr.push((0xE0 + (c >> 12)).to_byte())
      arr.push((0x80 + ((c >> 6) & 0x3F)).to_byte())
      arr.push((0x80 + (c & 0x3F)).to_byte())
    } else {
      arr.push((0xF0 + (c >> 18)).to_byte())
      arr.push((0x80 + ((c >> 12) & 0x3F)).to_byte())
      arr.push((0x80 + ((c >> 6) & 0x3F)).to_byte())
      arr.push((0x80 + (c & 0x3F)).to_byte())
    }
    i = i + 1
  }
  // Null terminator
  arr.push(b'\x00')
  Bytes::from_array(arr)
}

///| Convert a null-terminated or length-bounded UTF-8 Bytes to a MoonBit String.
fn cstr_to_string(bytes : Bytes) -> String {
  let res : Array[Char] = []
  let total_len = bytes.length()
  let mut i = 0
  while i < total_len {
    let c = bytes[i].to_int()
    if c == 0 {
      break
    }
    if c < 0x80 {
      res.push(Int::unsafe_to_char(c))
      i += 1
    } else if c < 0xE0 {
      if i + 1 >= total_len { break }
      let ch = ((c & 0x1F) << 6) | (bytes[i + 1].to_int() & 0x3F)
      res.push(Int::unsafe_to_char(ch))
      i += 2
    } else if c < 0xF0 {
      if i + 2 >= total_len { break }
      let ch = ((c & 0x0F) << 12) |
        ((bytes[i + 1].to_int() & 0x3F) << 6) |
        (bytes[i + 2].to_int() & 0x3F)
      res.push(Int::unsafe_to_char(ch))
      i += 3
    } else {
      if i + 3 >= total_len { break }
      let mut ch = ((c & 0x07) << 18) |
        ((bytes[i + 1].to_int() & 0x3F) << 12) |
        ((bytes[i + 2].to_int() & 0x3F) << 6) |
        (bytes[i + 3].to_int() & 0x3F)
      ch -= 0x10000
      res.push(Int::unsafe_to_char((ch >> 10) + 0xD800))
      res.push(Int::unsafe_to_char((ch & 0x3FF) + 0xDC00))
      i += 4
    }
  }
  String::from_array(res)
}
