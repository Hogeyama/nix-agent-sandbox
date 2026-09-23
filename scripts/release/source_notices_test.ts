import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectSourceNotices,
  headerNotice,
  renderSourceNotices,
} from "./source_notices.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

const bsd2 = (holder: string, style: "block" | "line") => {
  const body = [
    `Copyright (C) 2008-2019 ${holder} All rights reserved.`,
    "",
    "Redistribution and use in source and binary forms, with or without",
    "modification, are permitted provided that the following conditions",
    "are met:",
    "1. Redistributions of source code must retain the above copyright",
    "   notice, this list of conditions and the following disclaimer.",
    "",
    "THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR",
    "IMPLIED WARRANTIES ARE DISCLAIMED, EVEN IF ADVISED OF THE POSSIBILITY OF",
    "SUCH DAMAGE.",
  ];
  return style === "block"
    ? `/*\n${body.map((l) => ` * ${l}`.trimEnd()).join("\n")}\n */\n\n#include "config.h"\n`
    : `${body.map((l) => `// ${l}`.trimEnd()).join("\n")}\n\nfn main() {}\n`;
};

test("reads the copyright and BSD terms from a file's leading comment", () => {
  const notice = headerNotice(bsd2("Apple Inc.", "block"));
  expect(notice?.copyrights).toEqual([
    "Copyright (C) 2008-2019 Apple Inc. All rights reserved.",
  ]);
  expect(notice?.terms.startsWith("Redistribution and use in source")).toBe(
    true,
  );
  expect(notice?.terms.endsWith("SUCH DAMAGE.")).toBe(true);
});

test("reads MIT terms and ignores files without permissive header terms", () => {
  const mit = headerNotice(
    [
      "// Copyright Joyent, Inc. and other Node contributors.",
      "//",
      "// Permission is hereby granted, free of charge, to any person obtaining a",
      '// copy of this software, to deal in the Software. THE SOFTWARE IS PROVIDED "AS IS",',
      "// IN NO EVENT SHALL THE AUTHORS BE LIABLE, OUT OF OR IN CONNECTION WITH THE SOFTWARE",
      "// OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.",
      "",
      "'use strict';",
    ].join("\n"),
  );
  expect(mit?.copyrights).toEqual([
    "Copyright Joyent, Inc. and other Node contributors.",
  ]);
  expect(mit?.terms.endsWith("OTHER DEALINGS IN THE SOFTWARE.")).toBe(true);
  expect(
    headerNotice(
      "/*\n * Copyright (C) 2001 Peter Kelly\n *\n * This library is free software; you can redistribute it under the GNU Library General Public License.\n */\n",
    ),
  ).toBeUndefined();
});

test("reads unprefixed block comments and a terms end split across lines", () => {
  const notice = headerNotice(
    [
      "/*",
      "",
      "Copyright (C) 2014-2019 Apple Inc. All rights reserved.",
      "",
      "Redistribution and use in source and binary forms, with or without",
      "modification, are permitted. EVEN IF ADVISED OF THE POSSIBILITY OF SUCH",
      "DAMAGE.",
      "",
      "*/",
      '#include "config.h"',
    ].join("\n"),
  );
  expect(notice?.copyrights).toEqual([
    "Copyright (C) 2014-2019 Apple Inc. All rights reserved.",
  ]);
  expect(notice?.terms.endsWith("POSSIBILITY OF SUCH DAMAGE.")).toBe(true);
});

test("reads a notice for code copied below other code", () => {
  const notice = headerNotice(
    [
      'const { spawn } = require("internal/child_process");',
      "",
      "// Copyright Joyent, Inc. and other Node contributors.",
      "//",
      "// Permission is hereby granted, free of charge, to any person. OTHER",
      "",
      "// DEALINGS IN THE SOFTWARE.",
      "function exec() {}",
    ].join("\n"),
  );
  expect(notice?.copyrights).toEqual([
    "Copyright Joyent, Inc. and other Node contributors.",
  ]);
  expect(
    headerNotice(
      'const text = "Permission is hereby granted, free of charge. DEALINGS IN THE SOFTWARE.";\n',
    ),
  ).toBeUndefined();
});

test("groups identical terms across comment styles and lists each holder once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nas-source-notices-"));
  temporary.push(dir);
  await mkdir(join(dir, "a/b"), { recursive: true });
  await writeFile(join(dir, "a/one.cpp"), bsd2("Apple Inc.", "block"));
  await writeFile(join(dir, "a/b/two.rs"), bsd2("Google Inc.", "line"));
  await writeFile(join(dir, "a/b/three.h"), bsd2("Apple Inc.", "block"));
  await writeFile(join(dir, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  const groups = await collectSourceNotices([dir]);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.copyrights).toEqual([
    "Copyright (C) 2008-2019 Apple Inc. All rights reserved.",
    "Copyright (C) 2008-2019 Google Inc. All rights reserved.",
  ]);
  expect(groups[0]?.files).toBe(3);
  const text = renderSourceNotices(groups);
  expect(text).toContain("Google Inc.");
  expect(text).toContain("SUCH DAMAGE.");
});
