// Must be imported before anything from @solana/web3.js or Anchor.
import { Buffer } from "buffer";
(globalThis as any).Buffer ??= Buffer;
