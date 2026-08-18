import { describe, expect, it } from 'vitest';
import {
  OMP_MAX_FRAME_BYTES,
  OMP_RPC_CHUNK_PAYLOAD_BYTES,
} from '../ompContract';
import { OmpChunkReassembler, OmpFrameError, OmpLineDecoder } from '../ompFrameDecoder';

/** Slice a logical frame into v2 chunks exactly as OMP's encoder does. */
function chunksFor(frame: object, chunkId = 'rpc-1'): Record<string, unknown>[] {
  const json = JSON.stringify(frame);
  const bytes = Buffer.from(json, 'utf8');
  const count = Math.ceil(bytes.byteLength / OMP_RPC_CHUNK_PAYLOAD_BYTES);
  return Array.from({ length: count }, (_unused, index) => ({
    type: 'rpc_chunk',
    chunkId,
    index,
    count,
    byteLength: bytes.byteLength,
    data: bytes
      .subarray(index * OMP_RPC_CHUNK_PAYLOAD_BYTES, (index + 1) * OMP_RPC_CHUNK_PAYLOAD_BYTES)
      .toString('base64'),
  }));
}

/** A frame comfortably past the 1 MiB physical ceiling, so chunking applies. */
function oversizedFrame(): { type: string; text: string } {
  return { type: 'message_end', text: 'x'.repeat(OMP_MAX_FRAME_BYTES + 4_096) };
}

describe('OmpLineDecoder', () => {
  it('splits NDJSON and passes non-chunk values straight through', () => {
    const decoder = new OmpLineDecoder();
    expect(decoder.push('{"type":"a"}\n{"type":"b"}\n')).toEqual([{ type: 'a' }, { type: 'b' }]);
  });

  it('buffers a frame split across data events', () => {
    const decoder = new OmpLineDecoder();
    expect(decoder.push('{"type":"rea')).toEqual([]);
    expect(decoder.push('dy"}\n')).toEqual([{ type: 'ready' }]);
  });

  it('preserves a multi-byte character split across chunk boundaries', () => {
    const decoder = new OmpLineDecoder();
    const encoded = Buffer.from('{"text":"café"}\n', 'utf8');
    const splitAt = encoded.indexOf(Buffer.from('é', 'utf8')) + 1;
    expect(decoder.push(encoded.subarray(0, splitAt))).toEqual([]);
    expect(decoder.push(encoded.subarray(splitAt))).toEqual([{ text: 'café' }]);
  });

  it('tolerates \\r\\n line endings and blank lines', () => {
    const decoder = new OmpLineDecoder();
    expect(decoder.push('{"type":"a"}\r\n\n{"type":"b"}\n')).toEqual([{ type: 'a' }, { type: 'b' }]);
  });

  it('reports an unparseable line and keeps the surrounding frames', () => {
    const seen: string[] = [];
    const decoder = new OmpLineDecoder({ onUnparseableLine: (line) => seen.push(line) });
    expect(decoder.push('{"type":"a"}\nnot json\n{"type":"b"}\n'))
      .toEqual([{ type: 'a' }, { type: 'b' }]);
    expect(seen).toEqual(['not json']);
  });

  it('throws when a completed line exceeds the physical frame limit', () => {
    const decoder = new OmpLineDecoder({ maxFrameBytes: 32 });
    expect(() => decoder.push(`${'x'.repeat(64)}\n`)).toThrow(OmpFrameError);
  });

  it('throws when the UNTERMINATED buffer exceeds the limit', () => {
    // Catches an endless write with no newline before it can grow unbounded.
    const decoder = new OmpLineDecoder({ maxFrameBytes: 32 });
    expect(() => decoder.push('x'.repeat(64))).toThrow(/physical frame limit/);
  });

  it('returns trailing partial text from end()', () => {
    const decoder = new OmpLineDecoder();
    decoder.push('{"a":1}\n{"b"');
    expect(decoder.end()).toBe('{"b"');
  });
});

describe('OmpChunkReassembler', () => {
  it('passes a non-chunk frame through untouched', () => {
    const reassembler = new OmpChunkReassembler();
    expect(reassembler.push({ type: 'agent_start' })).toEqual({ type: 'agent_start' });
    expect(reassembler.isReassembling).toBe(false);
  });

  it('reassembles a multi-chunk frame in index order', () => {
    const frame = oversizedFrame();
    const chunks = chunksFor(frame);
    expect(chunks.length).toBeGreaterThan(1);

    const reassembler = new OmpChunkReassembler();
    for (const chunk of chunks.slice(0, -1)) {
      expect(reassembler.push(chunk)).toBeUndefined();
      expect(reassembler.isReassembling).toBe(true);
    }
    expect(reassembler.push(chunks[chunks.length - 1])).toEqual(frame);
    expect(reassembler.isReassembling).toBe(false);
  });

  it('rejects a sequence that does not start at index 0', () => {
    const reassembler = new OmpChunkReassembler();
    expect(() => reassembler.push(chunksFor(oversizedFrame())[1]))
      .toThrow(/must start at index 0/);
  });

  it('rejects a chunk that skips an index', () => {
    const chunks = chunksFor(oversizedFrame());
    expect(chunks.length).toBeGreaterThan(2);
    const reassembler = new OmpChunkReassembler();
    reassembler.push(chunks[0]);
    // Jumping 0 -> 2 would splice a hole into the payload.
    expect(() => reassembler.push(chunks[2])).toThrow(/did not match the run/);
    expect(reassembler.isReassembling).toBe(false);
  });

  it('rejects a run interrupted by an ordinary frame', () => {
    const chunks = chunksFor(oversizedFrame());
    const reassembler = new OmpChunkReassembler();
    reassembler.push(chunks[0]);
    // Splicing an unrelated frame in would silently corrupt the payload.
    expect(() => reassembler.push({ type: 'agent_start' })).toThrow(/interrupted/);
    expect(reassembler.isReassembling).toBe(false);
  });

  it('rejects a chunk from a DIFFERENT run mid-sequence', () => {
    const first = chunksFor(oversizedFrame(), 'rpc-1');
    const second = chunksFor(oversizedFrame(), 'rpc-2');
    const reassembler = new OmpChunkReassembler();
    reassembler.push(first[0]);
    expect(() => reassembler.push({ ...second[1], index: 1 })).toThrow(/did not match the run/);
  });

  it('rejects invalid chunk metadata', () => {
    const [chunk] = chunksFor(oversizedFrame());
    const reassembler = new OmpChunkReassembler();
    // A single-chunk "run" is malformed: chunking only happens past the ceiling.
    expect(() => reassembler.push({ ...chunk, count: 1 })).toThrow(/invalid metadata/);
    // byteLength below the physical ceiling means it should never have chunked.
    expect(() => reassembler.push({ ...chunk, byteLength: 10 })).toThrow(/invalid metadata/);
    expect(() => reassembler.push({ ...chunk, chunkId: '' })).toThrow(/invalid metadata/);
    expect(() => reassembler.push({ ...chunk, index: -1 })).toThrow(/invalid metadata/);
  });

  it('rejects non-canonical base64 payloads', () => {
    const [chunk] = chunksFor(oversizedFrame());
    const reassembler = new OmpChunkReassembler();
    expect(() => reassembler.push({ ...chunk, data: 'not base64!!' })).toThrow(/base64/);
  });

  it('rejects a run whose bytes do not match its declared length', () => {
    const chunks = chunksFor(oversizedFrame());
    const reassembler = new OmpChunkReassembler();
    for (const chunk of chunks.slice(0, -1)) reassembler.push(chunk);
    // Last chunk replaced with a shorter payload.
    const last = chunks[chunks.length - 1];
    expect(() => reassembler.push({ ...last, data: Buffer.from('xx').toString('base64') }))
      .toThrow(/length did not match/);
  });

  it('reset() abandons a partial run', () => {
    const chunks = chunksFor(oversizedFrame());
    const reassembler = new OmpChunkReassembler();
    reassembler.push(chunks[0]);
    reassembler.reset();
    expect(reassembler.isReassembling).toBe(false);
    expect(reassembler.push({ type: 'agent_start' })).toEqual({ type: 'agent_start' });
  });
});
