export const tableStyle = {
  width: "100%",
  borderCollapse: "collapse" as const,
};
export const thStyle = {
  textAlign: "left" as const,
  padding: "8px",
  borderBottom: "1px solid #334155",
  color: "#94a3b8",
  fontSize: "12px",
  textTransform: "uppercase" as const,
};
export const rowStyle = { cursor: "pointer" as const };
export const tdStyle = { padding: "8px", borderBottom: "1px solid #1e293b" };
export const tdNameStyle = {
  ...tdStyle,
  display: "flex" as const,
  alignItems: "center" as const,
  gap: "8px",
  whiteSpace: "nowrap" as const,
};
export const detailCellStyle = {
  padding: "0",
  borderBottom: "1px solid #1e293b",
  background: "#0f172a",
};
export const detailPanelStyle = {
  padding: "12px 16px",
  display: "flex",
  flexDirection: "column" as const,
  gap: "12px",
};
export const detailMutedStyle = {
  color: "#64748b",
  fontStyle: "italic" as const,
};
export const lastMessageStyle = {
  fontSize: "15px",
  color: "#e2e8f0",
  padding: "8px 12px",
  background: "#1e293b",
  borderLeft: "3px solid #6366f1",
  borderRadius: "4px",
  whiteSpace: "pre-wrap" as const,
};
export const kvGridStyle = {
  display: "grid",
  gridTemplateColumns: "140px 1fr",
  rowGap: "4px",
  columnGap: "12px",
  fontSize: "13px",
};
export const kvLabelStyle = {
  color: "#94a3b8",
  textTransform: "uppercase" as const,
  fontSize: "11px",
};
export const kvValueStyle = {
  color: "#cbd5e1",
  wordBreak: "break-all" as const,
};
export const rawDetailsStyle = {
  marginTop: "4px",
  fontSize: "12px",
};
export const rawSummaryStyle = {
  color: "#64748b",
  cursor: "pointer" as const,
  userSelect: "none" as const,
};
export const rawPreStyle = {
  marginTop: "6px",
  padding: "8px",
  background: "#020617",
  color: "#94a3b8",
  fontSize: "11px",
  borderRadius: "4px",
  overflow: "auto" as const,
  maxHeight: "200px",
};
export const tdPwdStyle = {
  ...tdStyle,
  maxWidth: "200px",
  overflow: "hidden" as const,
  textOverflow: "ellipsis" as const,
  whiteSpace: "nowrap" as const,
  fontSize: "13px",
  color: "#94a3b8",
};
export const attachBtnStyle = {
  background: "rgba(124, 196, 255, 0.2)",
  color: "#9dd2ff",
  border: "1px solid rgba(124, 196, 255, 0.4)",
  borderRadius: "4px",
  padding: "4px 12px",
  cursor: "pointer",
};
export const ackBtnStyle = {
  background: "rgba(148, 163, 184, 0.2)",
  color: "#cbd5e1",
  border: "1px solid rgba(148, 163, 184, 0.45)",
  borderRadius: "4px",
  padding: "4px 10px",
  cursor: "pointer",
};
export const ackedBtnStyle = {
  ...ackBtnStyle,
  background: "rgba(99, 102, 241, 0.2)",
  color: "#c7d2fe",
  border: "1px solid rgba(129, 140, 248, 0.45)",
  cursor: "default",
};
export const stopBtnStyle = {
  background: "#f59e0b",
  color: "white",
  border: "none",
  borderRadius: "4px",
  padding: "4px 12px",
  cursor: "pointer",
};
export const cleanBtnStyle = {
  background: "#6366f1",
  color: "white",
  border: "none",
  borderRadius: "6px",
  padding: "6px 16px",
  cursor: "pointer",
  fontSize: "14px",
};

export const nameInputStyle = {
  background: "#1e293b",
  color: "#e2e8f0",
  border: "1px solid #475569",
  borderRadius: "3px",
  padding: "2px 6px",
  fontSize: "13px",
  width: "140px",
};
export const nameSaveBtnStyle = {
  background: "rgba(99, 102, 241, 0.3)",
  color: "#c7d2fe",
  border: "1px solid rgba(129, 140, 248, 0.45)",
  borderRadius: "3px",
  padding: "2px 8px",
  cursor: "pointer",
  fontSize: "12px",
};
export const nameCancelBtnStyle = {
  background: "transparent",
  color: "#94a3b8",
  border: "1px solid #475569",
  borderRadius: "3px",
  padding: "2px 8px",
  cursor: "pointer",
  fontSize: "12px",
};

export const turnBadgeBaseStyle = {
  display: "inline-block",
  minWidth: "100px",
  textAlign: "center" as const,
  padding: "2px 8px",
  borderRadius: "10px",
  fontSize: "12px",
  lineHeight: "16px",
  whiteSpace: "nowrap" as const,
};
export const turnBadgeUserStyle = {
  ...turnBadgeBaseStyle,
  background: "#fbbf24",
  color: "#1f2937",
  fontWeight: "bold" as const,
};
export const turnBadgeAckStyle = {
  ...turnBadgeBaseStyle,
  background: "rgba(148, 163, 184, 0.22)",
  color: "#cbd5e1",
};
export const turnBadgeAgentStyle = {
  ...turnBadgeBaseStyle,
  background: "#334155",
  color: "#cbd5e1",
};
export const turnBadgeDoneStyle = {
  ...turnBadgeBaseStyle,
  background: "transparent",
  color: "#64748b",
};
