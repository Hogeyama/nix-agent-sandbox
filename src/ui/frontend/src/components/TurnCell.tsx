import type { ContainerInfo } from "../api.ts";
import {
  turnBadgeAckStyle,
  turnBadgeAgentStyle,
  turnBadgeDoneStyle,
  turnBadgeUserStyle,
} from "./containersTab.styles.ts";

interface TurnCellProps {
  turn: ContainerInfo["turn"];
}

export function TurnCell({ turn }: TurnCellProps) {
  if (turn === "user-turn") {
    return <span style={turnBadgeUserStyle}>Your turn</span>;
  }
  if (turn === "ack-turn") {
    return <span style={turnBadgeAckStyle}>Thinking (ACK)</span>;
  }
  if (turn === "agent-turn") {
    return <span style={turnBadgeAgentStyle}>Agent working</span>;
  }
  if (turn === "done") {
    return <span style={turnBadgeDoneStyle}>Done</span>;
  }
  return <span style={{ color: "#64748b" }}>-</span>;
}
