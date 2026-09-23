import { HTTP_STATUS, RETRY_CONFIG, DEFAULT_RETRY_CONFIG, resolveRetryEntry, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { shouldRefreshCredentials } from "../services/oauthCredentialManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { parseUpstreamError } from "../utils/error.js";
import { dbg } from "../utils/debugLog.js";
import { ANTHROPIC_API_VERSION, OPENAI_COMPAT_BASE, ANTHROPIC_COMPAT_BASE } from "../providers/shared.js";
import { resolveOpenAICompatibleApiType } from "../services/provider.js";

/**
 * BaseExecutor - Base class for provider executors
 */
export class BaseExecutor {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config ? { ...config } : {};
    this.noAuth = config?.noAuth || false;
  }

  getProvider() {
    return this.provider;
  }

  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }

  getFallbackCount() {
    return this.getBaseUrls().length || 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      const path = resolveOpenAICompatibleApiType(this.provider, credentials) === "responses" ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      // Anthropic-compatible providers use x-api-key header
      if (credentials.apiKey) {
        headers["x-api-key"] = credentials.apiKey;
      } else if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      }
      if (!headers["anthropic-version"]) {
        headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      }
    } else {
      // Standard Bearer token auth for other providers
      if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        headers["Authorization"] = `Bearer ${credentials.apiKey}`;
      }
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(model, body, stream, credentials) {
    return body;
  }

  shouldRetry(status, urlIndex) {
    return status === HTTP_STATUS.RATE_LIMITED && urlIndex + 1 < this.getFallbackCount();
  }

  // Override in subclass for provider-specific refresh
  async refreshCredentials(credentials, log, proxyOptions = null) {
    return null;
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials(this.provider, credentials);
  }

  parseError(response, bodyText) {
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, preResponse = null }) {
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    const retryAttemptsByUrl = {};

    // Merge default retry config with provider-specific config
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };

    // Schedule retry via retryConfig[statusKey]. Returns true when caller should `urlIndex--; continue`
    // response (optional) lets a subclass hook compute a dynamic delay (e.g. antigravity Retry-After).
    const tryRetry = async (urlIndex, statusKey, reason, response = null) => {
      const { attempts, delayMs } = resolveRetryEntry(retryConfig[statusKey]);
      if (attempts <= 0 || retryAttemptsByUrl[urlIndex] >= attempts) return false;
      // Hook: subclass may derive delay from the response (headers/body). null → skip retry, use fallback.
      let waitMs = delayMs;
      if (response && this.computeRetryDelay) {
        const dynamic = await this.computeRetryDelay(response, retryAttemptsByUrl[urlIndex] + 1, delayMs);
        if (dynamic === false) return false; // hook vetoes retry (e.g. Retry-After too long)
        if (dynamic != null) waitMs = dynamic;
      }
      if (preResponse) {
        if (preResponse.signal?.aborted || preResponse.remainingMs() <= waitMs) return false;
      }
      retryAttemptsByUrl[urlIndex]++;
      log?.debug?.("RETRY", `${reason} retry ${retryAttemptsByUrl[urlIndex]}/${attempts} after ${waitMs / 1000}s`);
      if (preResponse) {
        await preResponse.sleep(waitMs);
      } else {
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
      return true;
    };

    // Preserve transport-only fields before provider transforms mutate the body.
    const requestContext = { compact: body?._compact === true };

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex, credentials, requestContext);
      const transformedBody = this.transformRequest(model, body, stream, credentials);
      const headers = this.buildHeaders(credentials, stream, url, model, transformedBody, body);

      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;

      // Keep the first abort origin in the merged signal reason.
      const connectCtrl = new AbortController();
      const clientCtrl = new AbortController();
      const deadlineCtrl = new AbortController();
      let firstAbortReason = null;
      const mergedCtrl = new AbortController();
      const baseTimeout = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
      const budgetRemaining = preResponse ? preResponse.remainingMs() : Infinity;
      const timeoutMs = Math.min(baseTimeout, Math.max(1, budgetRemaining));
      const timeoutError = new Error(`Upstream connect timeout after ${timeoutMs}ms`);
      timeoutError.code = "UPSTREAM_CONNECT_TIMEOUT";
      timeoutError.status = HTTP_STATUS.GATEWAY_TIMEOUT;
      timeoutError.retryable = true;
      const clientError = new Error("Client closed request");
      clientError.code = "CLIENT_ABORT";
      clientError.status = 499;
      clientError.retryable = false;
      const forwardAbort = (source) => {
        if (firstAbortReason == null) firstAbortReason = source.reason;
        if (!mergedCtrl.signal.aborted) mergedCtrl.abort(source.reason);
      };
      const onConnectAbort = () => forwardAbort(connectCtrl.signal);
      const onClientAbort = () => forwardAbort(clientCtrl.signal);
      const onDeadlineAbort = () => forwardAbort(deadlineCtrl.signal);
      connectCtrl.signal.addEventListener("abort", onConnectAbort, { once: true });
      clientCtrl.signal.addEventListener("abort", onClientAbort, { once: true });
      deadlineCtrl.signal.addEventListener("abort", onDeadlineAbort, { once: true });
      const clientSignalListener = signal ? () => clientCtrl.abort(clientError) : null;
      if (clientSignalListener) {
        if (signal.aborted) clientSignalListener();
        else signal.addEventListener("abort", clientSignalListener, { once: true });
      }
      const preResponseListener = preResponse?.signal ? () => {
        deadlineCtrl.abort(preResponse.signal.reason);
      } : null;
      if (preResponseListener) {
        if (preResponse.signal.aborted) preResponseListener();
        else preResponse.signal.addEventListener("abort", preResponseListener, { once: true });
      }
      const connectTimer = setTimeout(() => connectCtrl.abort(timeoutError), timeoutMs);
      const mergedSignal = mergedCtrl.signal;
      const cleanupAbort = () => {
        clearTimeout(connectTimer);
        connectCtrl.signal.removeEventListener("abort", onConnectAbort);
        clientCtrl.signal.removeEventListener("abort", onClientAbort);
        deadlineCtrl.signal.removeEventListener("abort", onDeadlineAbort);
        if (clientSignalListener) signal.removeEventListener("abort", clientSignalListener);
        if (preResponseListener) preResponse.signal.removeEventListener("abort", preResponseListener);
      };
      try {
        const bodyStr = JSON.stringify(transformedBody);
        const fetchT0 = Date.now();
        const fetchPromise = proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: bodyStr,
          signal: mergedSignal
        }, proxyOptions);

        const response = await new Promise((resolve, reject) => {
          let settled = false;
          const onAbort = () => {
            if (settled) return;
            settled = true;
            reject(firstAbortReason || mergedSignal.reason || new Error("aborted"));
          };
          if (mergedSignal.aborted) return onAbort();
          mergedSignal.addEventListener("abort", onAbort, { once: true });
          fetchPromise.then(
            (res) => {
              if (settled) return;
              settled = true;
              mergedSignal.removeEventListener("abort", onAbort);
              resolve(res);
            },
            (err) => {
              if (settled) return;
              settled = true;
              mergedSignal.removeEventListener("abort", onAbort);
              reject(err);
            }
          );
        });
        cleanupAbort();
        if (response.ok) return { response, url, headers, transformedBody };

        const parsedError = await parseUpstreamError(response, this);
        if (parsedError.errorClass === "quota_exhausted") {
          return { response, url, headers, transformedBody };
        }

        if (parsedError.retryable !== false
          && await tryRetry(urlIndex, response.status, `status ${response.status}`, response)) {
          urlIndex--;
          continue;
        }

        if (this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue;
        }

        return { response, url, headers, transformedBody };
      } catch (error) {
        cleanupAbort();
        const abortReason = firstAbortReason || mergedSignal.reason;
        const clientAborted = abortReason?.code === "CLIENT_ABORT" || error?.code === "CLIENT_ABORT";
        const connectTimedOut = abortReason?.code === "UPSTREAM_CONNECT_TIMEOUT" || error?.code === "UPSTREAM_CONNECT_TIMEOUT";
        const deadlineExpired = abortReason?.code === "PRE_RESPONSE_DEADLINE_EXCEEDED" || error?.code === "PRE_RESPONSE_DEADLINE_EXCEEDED";
        let activeError = error;

        if (deadlineExpired) {
          activeError = abortReason || error;
          activeError.status = activeError.status || HTTP_STATUS.GATEWAY_TIMEOUT;
          throw activeError;
        } else if (connectTimedOut) {
          activeError = timeoutError;
          log?.warn?.("TIMEOUT", `${this.provider.toUpperCase()} connect timeout after ${timeoutMs}ms`);
        } else if (clientAborted) {
          activeError = clientError;
          log?.debug?.("ABORT", `${this.provider.toUpperCase()} client closed request`);
          throw clientError;
        }
        lastError = activeError;
        dbg("FETCH", `${this.provider.toUpperCase()} ✖ ${activeError.name || "Error"}: ${activeError.message}${connectTimedOut ? " (connect timeout)" : ""}`);

        // Client abort is terminal. Unknown AbortErrors remain terminal too.
        if (error.name === "AbortError" && !connectTimedOut) {
          throw activeError;
        }

        // Map timeout and network/fetch exceptions to retry config (504 for timeout, 502 for network)
        const isTimeout = connectTimedOut || error.status === HTTP_STATUS.GATEWAY_TIMEOUT || error.code === "UPSTREAM_CONNECT_TIMEOUT";
        const retryStatus = isTimeout ? HTTP_STATUS.GATEWAY_TIMEOUT : HTTP_STATUS.BAD_GATEWAY;
        if (await tryRetry(urlIndex, retryStatus, isTimeout ? "connect timeout" : `network "${error.message}"`)) { urlIndex--; continue; }
        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw activeError;
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }
}

export default BaseExecutor;
