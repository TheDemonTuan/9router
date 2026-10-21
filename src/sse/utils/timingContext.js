import crypto from "node:crypto";

function generateRequestId() {
  if (typeof crypto?.randomUUID === "function") {
    return `req_${crypto.randomUUID().replace(/-/g, "")}`;
  }
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export class TimingContext {
  constructor(receivedAt = Date.now(), options = {}) {
    this.requestId = options.requestId || generateRequestId();
    this.correlationId = options.correlationId || this.requestId;
    this.receivedAt = receivedAt;
    this.bodyParsedAt = null;
    this.authCheckedAt = null;
    this.accountSelectedAt = null;
    this.tokenRefreshedAt = null;
    this.coreEnteredAt = null;
    this.payloadPreparedAt = null;
    this.dispatchedAt = null;
    this.headersAt = null;
    this.firstByteAt = null;
    this.firstDownstreamByteAt = null;
    this.firstReasoningAt = null;
    this.firstTextAt = null;
    this.firstToolAt = null;
    this.terminalAt = null;
    this.cancelledAt = null;
    this.stages = new Map();
    this.stages.set("received", receivedAt);
  }

  mark(stage, timestamp = Date.now()) {
    if (timestamp == null || !Number.isFinite(timestamp)) return this;
    this.stages.set(stage, timestamp);
    if (stage === "bodyParsed" || stage === "body") this.bodyParsedAt = timestamp;
    else if (stage === "authChecked" || stage === "auth") this.authCheckedAt = timestamp;
    else if (stage === "accountSelected" || stage === "account") this.accountSelectedAt = timestamp;
    else if (stage === "tokenRefreshed" || stage === "refresh") this.tokenRefreshedAt = timestamp;
    else if (stage === "coreEntered" || stage === "core") this.coreEnteredAt = timestamp;
    else if (stage === "payloadPrepared" || stage === "payload") this.payloadPreparedAt = timestamp;
    else if (stage === "dispatched" || stage === "dispatch") this.dispatchedAt = timestamp;
    else if (stage === "headers" || stage === "hdr") this.headersAt = timestamp;
    else if (stage === "firstByte" || stage === "ubyte") this.firstByteAt ??= timestamp;
    else if (stage === "firstDownstreamByte" || stage === "dbyte") this.firstDownstreamByteAt ??= timestamp;
    else if (stage === "firstReasoning" || stage === "reasoning") this.firstReasoningAt ??= timestamp;
    else if (stage === "firstText" || stage === "ftext") this.firstTextAt ??= timestamp;
    else if (stage === "firstTool" || stage === "tool") this.firstToolAt ??= timestamp;
    else if (stage === "terminal" || stage === "done") this.terminalAt ??= timestamp;
    else if (stage === "cancelled" || stage === "cancel") this.cancelledAt ??= timestamp;
    return this;
  }

  get(stage) {
    return this.stages.get(stage) ?? null;
  }

  get durations() {
    const received = this.receivedAt;
    const bodyMs = this.bodyParsedAt != null ? Math.max(0, this.bodyParsedAt - received) : null;
    const lastBeforeAuth = this.bodyParsedAt ?? received;
    const authMs = this.authCheckedAt != null ? Math.max(0, this.authCheckedAt - lastBeforeAuth) : null;
    const lastBeforeAccount = this.authCheckedAt ?? lastBeforeAuth;
    const accountMs = this.accountSelectedAt != null ? Math.max(0, this.accountSelectedAt - lastBeforeAccount) : null;
    const lastBeforeRefresh = this.accountSelectedAt ?? lastBeforeAccount;
    const refreshMs = this.tokenRefreshedAt != null ? Math.max(0, this.tokenRefreshedAt - lastBeforeRefresh) : null;
    const latestAnchor = this.coreEnteredAt ?? this.tokenRefreshedAt ?? this.accountSelectedAt ?? this.authCheckedAt ?? this.bodyParsedAt ?? received;
    const preCoreMs = Math.max(0, latestAnchor - received);
    const coreBase = this.coreEnteredAt ?? latestAnchor;
    const payloadPrepMs = this.payloadPreparedAt != null ? Math.max(0, this.payloadPreparedAt - coreBase) : null;
    const dispatchMs = this.dispatchedAt != null ? Math.max(0, this.dispatchedAt - received) : null;
    const headersMs = this.headersAt != null ? Math.max(0, this.headersAt - received) : null;
    const firstByteMs = this.firstByteAt != null ? Math.max(0, this.firstByteAt - received) : null;
    const firstDownstreamByteMs = this.firstDownstreamByteAt != null ? Math.max(0, this.firstDownstreamByteAt - received) : null;
    const firstReasoningMs = this.firstReasoningAt != null ? Math.max(0, this.firstReasoningAt - received) : null;
    const firstTextMs = this.firstTextAt != null ? Math.max(0, this.firstTextAt - received) : null;
    const firstToolMs = this.firstToolAt != null ? Math.max(0, this.firstToolAt - received) : null;
    const terminalMs = this.terminalAt != null ? Math.max(0, this.terminalAt - received) : null;
    const cancelledMs = this.cancelledAt != null ? Math.max(0, this.cancelledAt - received) : null;

    return {
      bodyMs,
      authMs,
      accountMs,
      refreshMs,
      preCoreMs,
      payloadPrepMs,
      dispatchMs,
      headersMs,
      firstByteMs,
      firstDownstreamByteMs,
      firstReasoningMs,
      firstTextMs,
      firstToolMs,
      terminalMs,
      cancelledMs,
    };
  }

  toObject() {
    return {
      requestId: this.requestId,
      correlationId: this.correlationId,
      receivedAt: this.receivedAt,
      bodyParsedAt: this.bodyParsedAt,
      authCheckedAt: this.authCheckedAt,
      accountSelectedAt: this.accountSelectedAt,
      tokenRefreshedAt: this.tokenRefreshedAt,
      coreEnteredAt: this.coreEnteredAt,
      payloadPreparedAt: this.payloadPreparedAt,
      dispatchedAt: this.dispatchedAt,
      headersAt: this.headersAt,
      firstByteAt: this.firstByteAt,
      firstDownstreamByteAt: this.firstDownstreamByteAt,
      firstReasoningAt: this.firstReasoningAt,
      firstTextAt: this.firstTextAt,
      firstToolAt: this.firstToolAt,
      terminalAt: this.terminalAt,
      cancelledAt: this.cancelledAt,
      durations: this.durations,
    };
  }

  toJSON() {
    return this.toObject();
  }
}

export function createTimingContext(initialTime = Date.now(), options = {}) {
  return new TimingContext(initialTime, options);
}
