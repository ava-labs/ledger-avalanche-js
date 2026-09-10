export interface ResponseBase {
  errorMessage: string;
  returnCode: number;
}

export interface ResponseAddress extends ResponseBase {
  publicKey: Buffer;
  hash?: Buffer;
  address: string;
}

export interface ResponseXPub extends ResponseBase {
  publicKey: Buffer;
  chain_code: Buffer;
}

export interface ResponseVersion extends ResponseBase {
  testMode: boolean;
  major: number;
  minor: number;
  patch: number;
  deviceLocked: boolean;
  targetId: string;
}

export interface ResponseAppInfo extends ResponseBase {
  appName: string;
  appVersion: string;
  flagLen: number;
  flagsValue: number;
  flagRecovery: boolean;
  flagSignedMcuCode: boolean;
  flagOnboarded: boolean;
  flagPINValidated: boolean;
}

export interface ResponseSign extends ResponseBase {
  // avax expect a map path -> signature
  hash: null | Buffer;
  signatures: null | Map<string, Buffer>;
}

export interface ResponseWalletId extends ResponseBase {
  id: Buffer;
}

/**
 * The transport surface this package needs in order to talk to a device.
 *
 * Deliberately structural rather than a nominal dependency on `Transport` from
 * `@ledgerhq/hw-transport`: this SDK only ever calls `send`, so describing that one method
 * lets it accept either a legacy `Transport` or a `DMKTransport` built on Ledger's Device
 * Management Kit, which replaces hw-transport ahead of the September 2026 cutoff.
 *
 * A `Transport` instance satisfies this interface as-is, so this is a widening: every
 * existing caller keeps compiling unchanged.
 */
export interface LedgerTransport {
  send: (
    cla: number,
    ins: number,
    p1: number,
    p2: number,
    data?: Buffer,
    statusList?: number[],
    options?: { abortTimeoutMs?: number },
  ) => Promise<Buffer>;
}
