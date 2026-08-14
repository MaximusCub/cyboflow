/**
 * ompFrameDecoder — NDJSON line splitting plus protocol-v2 chunk reassembly.
 *
 * Protocol v1 puts one JSON object on each stdout line. Protocol v2 additionally
 * lets OMP emit an oversized logical frame as an uninterrupted run of
 * `rpc_chunk` frames carrying base64 slices of the original UTF-8 JSON
 * (rpc.md:54-67). Reassembly is deliberately STRICT — the validation below
 * mirrors OMP's own reference decoder (`packages/coding-agent/src/modes/rpc/
 * rpc-frame.ts:136-189`) rule for rule, because a lenient decoder would happily
 * splice two interleaved sequences into one plausible-looking frame.
 *
 * Running the reassembler unconditionally is safe on v1: a v1 server never emits
 * `rpc_chunk` at all (it shrinks or overflow-frames an oversized object instead,
 * rpc-frame.ts:248-263), so the chunk path is simply never entered.
 */
import { StringDecoder } from 'node:string_decoder';
import {
  OMP_MAX_FRAME_BYTES,
  OMP_MAX_REASSEMBLED_FRAME_BYTES,
  OMP_RPC_CHUNK_PAYLOAD_BYTES,
  isOmpRpcChunkFrame,
} from './ompContract';

export class OmpFrameError extends Error {
  override readonly name: string = 'OmpFrameError';
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const MAX_CHUNK_COUNT = Math.ceil(OMP_MAX_REASSEMBLED_FRAME_BYTES / OMP_RPC_CHUNK_PAYLOAD_BYTES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeBase64(data: unknown): Buffer {
  if (typeof data !== 'string' || data.length === 0 || !BASE64_PATTERN.test(data)) {
    throw new OmpFrameError('OMP rpc chunk carried invalid base64 data');
  }
  const bytes = Buffer.from(data, 'base64');
  // Round-trip so a payload with non-canonical padding is rejected rather than
  // silently re-encoded to different bytes.
  if (bytes.toString('base64') !== data) {
    throw new OmpFrameError('OMP rpc chunk carried non-canonical base64 data');
  }
  return bytes;
}

interface PendingChunks {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  chunks: Buffer[];
  receivedBytes: number;
}

/**
 * Reassembles protocol-v2 chunk runs. Feed it each already-parsed JSONL value;
 * it returns the logical frame, or `undefined` while a chunk run is still
 * incomplete. Any protocol violation throws `OmpFrameError`.
 */
export class OmpChunkReassembler {
  private pending: PendingChunks | undefined;

  get isReassembling(): boolean {
    return this.pending !== undefined;
  }

  push(value: unknown): Record<string, unknown> | undefined {
    if (!isOmpRpcChunkFrame(value)) {
      // A non-chunk frame in the middle of a run means the sequence was
      // interleaved or truncated; the partial bytes can no longer be trusted.
      if (this.pending) {
        this.pending = undefined;
        throw new OmpFrameError('OMP rpc chunk sequence was interrupted');
      }
      if (!isRecord(value)) throw new OmpFrameError('OMP rpc frame must be a JSON object');
      return value;
    }

    const { chunkId, index, count, byteLength } = value;
    if (
      typeof chunkId !== 'string'
      || chunkId.length === 0
      || chunkId.length > 128
      || !Number.isSafeInteger(index)
      || !Number.isSafeInteger(count)
      || !Number.isSafeInteger(byteLength)
      || index < 0
      || count < 2
      || count > MAX_CHUNK_COUNT
      || index >= count
      // A chunked frame is by definition one that did not fit in a physical
      // frame, so anything smaller is malformed (rpc-frame.ts:157).
      || byteLength < OMP_MAX_FRAME_BYTES
      || byteLength > OMP_MAX_REASSEMBLED_FRAME_BYTES
    ) {
      this.pending = undefined;
      throw new OmpFrameError('OMP rpc chunk carried invalid metadata');
    }

    const bytes = decodeBase64(value.data);
    if (bytes.byteLength > OMP_RPC_CHUNK_PAYLOAD_BYTES) {
      this.pending = undefined;
      throw new OmpFrameError('OMP rpc chunk payload exceeded the transport limit');
    }

    if (!this.pending) {
      if (index !== 0) throw new OmpFrameError('OMP rpc chunk sequence must start at index 0');
      this.pending = { chunkId, count, byteLength, nextIndex: 0, chunks: [], receivedBytes: 0 };
    }

    const pending = this.pending;
    if (
      pending.chunkId !== chunkId
      || pending.count !== count
      || pending.byteLength !== byteLength
      || pending.nextIndex !== index
    ) {
      this.pending = undefined;
      throw new OmpFrameError('OMP rpc chunk sequence did not match the run in progress');
    }

    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    pending.nextIndex += 1;
    if (pending.receivedBytes > pending.byteLength) {
      this.pending = undefined;
      throw new OmpFrameError('OMP rpc chunk sequence exceeded its declared length');
    }
    if (pending.nextIndex < pending.count) return undefined;
    if (pending.receivedBytes !== pending.byteLength) {
      this.pending = undefined;
      throw new OmpFrameError('OMP rpc chunk sequence length did not match its declaration');
    }

    this.pending = undefined;
    // `fatal: true` so a chunk boundary that split a multi-byte sequence
    // incorrectly is a loud failure rather than a U+FFFD-laced frame.
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pending.chunks));
    const frame: unknown = JSON.parse(decoded);
    if (!isRecord(frame)) throw new OmpFrameError('OMP rpc frame must be a JSON object');
    return frame;
  }

  reset(): void {
    this.pending = undefined;
  }
}

export interface OmpLineDecoderOptions {
  /** Physical frame ceiling; a longer inbound line is a protocol violation. */
  readonly maxFrameBytes?: number;
  /**
   * Called for a line that is not parseable JSON. OMP itself tolerates malformed
   * INBOUND lines (rpc.md:781), and a stray non-JSON write on stdout must not
   * take the transport down, so unparseable lines are reported and skipped.
   */
  readonly onUnparseableLine?: (line: string, error: Error) => void;
}

/**
 * Splits a byte stream into NDJSON frames. Uses `StringDecoder` so a chunk
 * boundary that lands mid-UTF-8-sequence does not corrupt the character, and
 * enforces the physical frame ceiling on both completed lines and the pending
 * buffer (an unterminated flood is caught before it can grow unbounded).
 */
export class OmpLineDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private readonly maxFrameBytes: number;
  private buffer = '';

  constructor(private readonly options: OmpLineDecoderOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? OMP_MAX_FRAME_BYTES;
  }

  /** Decode a stdout chunk into zero or more parsed JSON values. */
  push(chunk: Buffer | string): unknown[] {
    this.buffer += this.decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    const values: unknown[] = [];

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > 0) {
        if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) {
          throw new OmpFrameError('OMP rpc frame exceeded the physical frame limit');
        }
        try {
          values.push(JSON.parse(line) as unknown);
        } catch (error) {
          this.options.onUnparseableLine?.(
            line,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
      newlineIndex = this.buffer.indexOf('\n');
    }

    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxFrameBytes) {
      throw new OmpFrameError('OMP rpc frame exceeded the physical frame limit');
    }
    return values;
  }

  /** Flush the decoder at stream end; returns any trailing partial text. */
  end(): string {
    this.buffer += this.decoder.end();
    const remainder = this.buffer;
    this.buffer = '';
    return remainder;
  }
}
