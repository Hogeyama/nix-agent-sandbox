//! ブローカーへの入力のフレーム。クライアント (relay.zig) とサーバー (serve.zig) が
//! 同じ定義を使うよう、ここに一本化する。
//!
//!   [長さ: u32 ビッグエンディアン][その長さのバイト列]
//!
//! 長さは 1..MAX_BODY。**長さ 0 のフレームが入力の終わり**を表す。
//! half-close (`shutdown(SHUT_WR)`) で終わりを伝えないのは、srt の proxy が
//! half-close を通さず、クライアントが half-close した時点で逆向きも閉じるため
//! (サーバーが返す末尾がクライアントに届かない)。

const std = @import("std");

/// 1 フレームの本文の上限。relay がパイプから 1 回に読む量 (`relay.CHUNK_SIZE`) と
/// 同じにして、読んだ塊をそのまま 1 フレームにできるようにする。サーバーは
/// これを越える長さを受け取ったら、相手をクライアントではないとみなして閉じる。
pub const MAX_BODY: usize = 64 * 1024;

pub const HEADER_LEN: usize = 4;

/// 長さ len のフレームのヘッダ。len 0 は入力の終わり。
pub fn header(len: usize) [HEADER_LEN]u8 {
    std.debug.assert(len <= MAX_BODY);
    var h: [HEADER_LEN]u8 = undefined;
    std.mem.writeInt(u32, &h, @intCast(len), .big);
    return h;
}

/// ヘッダから本文の長さを読む。
pub fn bodyLen(h: *const [HEADER_LEN]u8) u32 {
    return std.mem.readInt(u32, h, .big);
}

test "header: big-endian length round-trips" {
    const h = header(0x0102);
    try std.testing.expectEqualSlices(u8, &.{ 0, 0, 1, 2 }, &h);
    try std.testing.expectEqual(@as(u32, 0x0102), bodyLen(&h));
    try std.testing.expectEqual(@as(u32, 0), bodyLen(&header(0)));
}
