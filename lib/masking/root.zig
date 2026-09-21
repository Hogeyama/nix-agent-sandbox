//! Shared byte masking and incremental stream masking.
pub const mask = @import("mask.zig");
pub const stream = @import("stream.zig");

test {
    _ = mask;
    _ = stream;
}
