import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";

// ── Types ──

export interface ExchangeBalance {
  exchange: string;
  equity: string;
  available: string;
}

export interface BotTuiState {
  phase: string;
  equity: number;
  peakEquity: number;
  dailyPnl: number;
  fills: number;
  totalPnl: number;
  runtime: number;
  strategy: string;
  symbol: string;
  exchange: string;
  price: number;
  volume24h: number;
  openInterest: string;
  fundingRate: number;
  volatility24h: number;
  positions: Position[];
  openOrders: OpenOrder[];
  strategyState: Record<string, unknown>;
  tick: number;
  exchangeBalances?: ExchangeBalance[];
}

export interface Position {
  symbol: string;
  side: string;
  size: string;
  entryPrice: string;
  markPrice: string;
  unrealizedPnl: string;
  exchange?: string;
}

export interface OpenOrder {
  orderId: string;
  side: string;
  price: string;
  size: string;
  type: string;
}

export interface LogEntry {
  time: string;
  message: string;
}

export type StateListener = (state: BotTuiState) => void;
export type LogListener = (entry: LogEntry) => void;

export interface DashboardProps {
  initialState: BotTuiState;
  onQuit: () => void;
  onPause: () => void;
  subscribe: (onState: StateListener, onLog: LogListener) => () => void;
}

// ── Helpers ──

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m${sec % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function pnlColor(val: number): "green" | "red" | "white" {
  if (val > 0) return "green";
  if (val < 0) return "red";
  return "white";
}

function phaseIndicator(phase: string): string {
  switch (phase) {
    case "monitoring": return "[ MONITORING ]";
    case "entering":   return "[  ENTERING  ]";
    case "running":    return "[   RUNNING   ]";
    case "exiting":    return "[   EXITING   ]";
    case "paused":     return "[   PAUSED   ]";
    case "stopped":    return "[  STOPPED   ]";
    default:           return `[ ${phase.toUpperCase()} ]`;
  }
}

function phaseColor(phase: string): "cyan" | "green" | "yellow" | "red" | "gray" {
  switch (phase) {
    case "monitoring": return "cyan";
    case "entering":   return "yellow";
    case "running":    return "green";
    case "exiting":    return "yellow";
    case "paused":     return "gray";
    case "stopped":    return "red";
    default:           return "cyan";
  }
}

const MAX_LOG_LINES = 15;

// ── Component ──

export function BotDashboard({ initialState, onQuit, onPause, subscribe }: DashboardProps) {
  const { exit } = useApp();
  const [state, setState] = useState<BotTuiState>(initialState);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribe(
      (newState) => setState(newState),
      (entry) => setLogs((prev) => [...prev.slice(-(MAX_LOG_LINES - 1)), entry]),
    );
    return unsubscribe;
  }, [subscribe]);

  const handleQuit = useCallback(() => {
    onQuit();
    exit();
  }, [onQuit, exit]);

  useInput((input, key) => {
    if (input === "q" || input === "Q" || (key.ctrl && input === "c")) {
      handleQuit();
    }
    if (input === "p" || input === "P") {
      setPaused((v) => !v);
      onPause();
    }
  });

  const drawdown = state.peakEquity - state.equity;
  const drawdownPct = state.peakEquity > 0 ? (drawdown / state.peakEquity) * 100 : 0;
  const bidOrders = state.openOrders.filter((o) => o.side.toLowerCase() === "buy");
  const askOrders = state.openOrders.filter((o) => o.side.toLowerCase() === "sell");
  const hasMultiExchange = (state.exchangeBalances?.length ?? 0) > 1;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* ── Header ── */}
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Box flexDirection="column">
          <Text bold color="cyan">
            {state.strategy} | {state.symbol} | {state.exchange}
          </Text>
          <Text color="gray">
            Runtime: {formatDuration(state.runtime)} | Tick: {state.tick}
          </Text>
        </Box>
        <Box>
          <Text bold color={phaseColor(state.phase)}>
            {phaseIndicator(state.phase)}
          </Text>
        </Box>
      </Box>

      {/* ── Price Bar ── */}
      <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="row" justifyContent="space-between">
        <Text>
          Price: <Text bold color="white">${state.price.toFixed(2)}</Text>
        </Text>
        <Text color="gray">
          Vol24h: <Text color="white">{state.volatility24h.toFixed(1)}%</Text>
        </Text>
        <Text color="gray">
          FR: <Text color={state.fundingRate >= 0 ? "green" : "red"}>
            {(state.fundingRate * 100).toFixed(4)}%
          </Text>
        </Text>
        <Text color="gray">
          OI: <Text color="white">{state.openInterest}</Text>
        </Text>
      </Box>

      {/* ── Account ── */}
      <Box marginTop={1} flexDirection="row" justifyContent="space-between">
        <Box flexDirection="column">
          <Text color="cyan" bold>Account</Text>
          <Text>
            Equity: <Text bold color="white">${state.equity.toFixed(2)}</Text>
            <Text color="gray"> (peak: ${state.peakEquity.toFixed(2)})</Text>
          </Text>
          <Text>
            Daily P&L: <Text bold color={pnlColor(state.dailyPnl)}>${state.dailyPnl.toFixed(2)}</Text>
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text> </Text>
          <Text>
            Drawdown: <Text bold color={drawdown > 0 ? "red" : "green"}>
              ${drawdown.toFixed(2)} ({drawdownPct.toFixed(1)}%)
            </Text>
          </Text>
          <Text>
            Fills: <Text bold color="white">{state.fills}</Text>
            <Text color="gray"> | Total P&L: </Text>
            <Text bold color={pnlColor(state.totalPnl)}>${state.totalPnl.toFixed(2)}</Text>
          </Text>
        </Box>
      </Box>

      {/* ── Per-Exchange Balances ── */}
      {state.exchangeBalances && state.exchangeBalances.length > 1 && (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan" bold>Exchange Balances</Text>
          <Box flexDirection="row">
            <Text color="gray">{pad("Exchange", 16)}</Text>
            <Text color="gray">{pad("Equity", 14)}</Text>
            <Text color="gray">Available</Text>
          </Box>
          {state.exchangeBalances.map((eb, i) => (
            <Box key={i} flexDirection="row">
              <Text color="white">{pad(eb.exchange, 16)}</Text>
              <Text color="white">{pad(`$${parseFloat(eb.equity).toFixed(2)}`, 14)}</Text>
              <Text color="gray">${parseFloat(eb.available).toFixed(2)}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* ── Positions ── */}
      <Box marginTop={1} flexDirection="column">
        <Text color="cyan" bold>Positions</Text>
        {state.positions.length === 0 ? (
          <Text color="gray">  No open positions</Text>
        ) : (
          <Box flexDirection="column">
            <Box flexDirection="row">
              {hasMultiExchange && <Text color="gray">{pad("Exchange", 14)}</Text>}
              <Text color="gray">{pad("Symbol", 10)}</Text>
              <Text color="gray">{pad("Side", 6)}</Text>
              <Text color="gray">{pad("Size", 12)}</Text>
              <Text color="gray">{pad("Entry", 12)}</Text>
              <Text color="gray">{pad("Mark", 12)}</Text>
              <Text color="gray">uPnL</Text>
            </Box>
            {state.positions.map((p, i) => {
              const upnl = parseFloat(p.unrealizedPnl);
              return (
                <Box key={i} flexDirection="row">
                  {hasMultiExchange && <Text color="cyan">{pad(p.exchange ?? "—", 14)}</Text>}
                  <Text color="white">{pad(p.symbol, 10)}</Text>
                  <Text color={p.side.toLowerCase() === "long" ? "green" : "red"}>{pad(p.side, 6)}</Text>
                  <Text color="white">{pad(p.size, 12)}</Text>
                  <Text color="white">{pad(p.entryPrice, 12)}</Text>
                  <Text color="white">{pad(p.markPrice, 12)}</Text>
                  <Text color={pnlColor(upnl)}>${upnl.toFixed(2)}</Text>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      {/* ── Open Orders (bid | ask) ── */}
      <Box marginTop={1} flexDirection="row" justifyContent="space-between">
        <Box flexDirection="column" width="50%">
          <Text color="green" bold>Bids ({bidOrders.length})</Text>
          {bidOrders.length === 0 ? (
            <Text color="gray">  --</Text>
          ) : (
            bidOrders.slice(0, 8).map((o, i) => (
              <Text key={i} color="green">
                {pad(o.price, 12)} {pad(o.size, 10)} {o.type}
              </Text>
            ))
          )}
        </Box>
        <Box flexDirection="column" width="50%">
          <Text color="red" bold>Asks ({askOrders.length})</Text>
          {askOrders.length === 0 ? (
            <Text color="gray">  --</Text>
          ) : (
            askOrders.slice(0, 8).map((o, i) => (
              <Text key={i} color="red">
                {pad(o.price, 12)} {pad(o.size, 10)} {o.type}
              </Text>
            ))
          )}
        </Box>
      </Box>

      {/* ── Strategy State ── */}
      <Box marginTop={1} flexDirection="column">
        <Text color="cyan" bold>Strategy State</Text>
        <Box flexDirection="row" flexWrap="wrap">
          {Object.entries(state.strategyState).slice(0, 12).map(([k, v]) => (
            <Box key={k} marginRight={2}>
              <Text color="gray">{k}: </Text>
              <Text color="white">{String(v)}</Text>
            </Box>
          ))}
          {Object.keys(state.strategyState).length === 0 && (
            <Text color="gray">  --</Text>
          )}
        </Box>
      </Box>

      {/* ── Log ── */}
      <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} height={MAX_LOG_LINES + 2}>
        <Text color="cyan" bold>Log</Text>
        {logs.length === 0 ? (
          <Text color="gray">  Waiting for events...</Text>
        ) : (
          logs.map((entry, i) => (
            <Text key={i}>
              <Text color="gray">{entry.time} </Text>
              <Text>{colorizeLog(entry.message)}</Text>
            </Text>
          ))
        )}
      </Box>

      {/* ── Footer ── */}
      <Box marginTop={1} flexDirection="row" justifyContent="center">
        <Text color="gray">
          [<Text color="white" bold>Q</Text>]uit  [<Text color="white" bold>P</Text>]{paused ? "resume" : "ause"}
        </Text>
      </Box>
    </Box>
  );
}

// ── Utility ──

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

function colorizeLog(msg: string): React.ReactElement {
  // Strip ANSI codes for TUI since ink handles colors
  const clean = msg.replace(/\x1b\[[0-9;]*m/g, "");
  if (clean.includes("ERROR") || clean.includes("✗") || clean.includes("failed")) {
    return <Text color="red">{clean}</Text>;
  }
  if (clean.includes("WARNING") || clean.includes("⚠")) {
    return <Text color="yellow">{clean}</Text>;
  }
  if (clean.includes("✓") || clean.includes("started") || clean.includes("profit")) {
    return <Text color="green">{clean}</Text>;
  }
  return <Text color="gray">{clean}</Text>;
}
