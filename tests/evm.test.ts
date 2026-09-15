import { DeviceActionStatus } from "@ledgerhq/device-management-kit";
import { Observable } from "rxjs";
import { SignerEthBuilder } from "@ledgerhq/device-signer-kit-ethereum";

import AvalancheApp from "../src/index";
import {
  DeviceActionError,
  hexToBytes,
  runDeviceAction,
  toEvmTransactionSignature,
  type DeviceActionRun,
} from "../src/evm";
import type { EvmSignerOptions, LedgerTransport } from "../src/types";

const mockSigner = {
  signTransaction: jest.fn(),
  getAddress: jest.fn(),
  signTypedData: jest.fn(),
};
const mockWithContextModule = jest.fn();

jest.mock("@ledgerhq/device-signer-kit-ethereum", () => ({
  SignerEthBuilder: jest.fn().mockImplementation(() => ({
    withContextModule: mockWithContextModule,
    build: () => mockSigner,
  })),
}));

function completed<Output>(output: Output): DeviceActionRun<Output> {
  return {
    observable: new Observable((subscriber) => {
      subscriber.next({
        status: DeviceActionStatus.Pending,
        intermediateValue: {},
      });
      subscriber.next({ status: DeviceActionStatus.Completed, output });
      subscriber.complete();
    }),
    cancel() {},
  };
}

function failed(error: unknown): DeviceActionRun<never> {
  return {
    observable: new Observable((subscriber) => {
      subscriber.next({ status: DeviceActionStatus.Error, error });
    }),
    cancel() {},
  };
}

/** A transport that records every APDU and answers from a queue of canned responses. */
class FakeTransport implements LedgerTransport {
  readonly calls: Array<{
    cla: number;
    ins: number;
    p1: number;
    p2: number;
    data: Buffer | undefined;
    statusList: number[] | undefined;
  }> = [];
  private readonly responses: Buffer[];

  constructor(...responses: string[]) {
    this.responses = responses.map((hex) => Buffer.from(hex, "hex"));
  }

  send = (
    cla: number,
    ins: number,
    p1: number,
    p2: number,
    data?: Buffer,
    statusList?: number[],
  ): Promise<Buffer> => {
    this.calls.push({ cla, ins, p1, p2, data, statusList });
    const response = this.responses.shift();
    if (response === undefined) {
      return Promise.reject(new Error("no canned response left"));
    }
    return Promise.resolve(response);
  };
}

const evm = {
  dmk: {},
  sessionId: "session-1",
} as unknown as EvmSignerOptions;

const PATH = "m/44'/60'/0'/0/0";
const R = `0x${"11".repeat(32)}` as const;
const S = `0x${"22".repeat(32)}` as const;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("runDeviceAction", () => {
  it("resolves with the output of a completed action", async () => {
    await expect(runDeviceAction(completed(42))).resolves.toBe(42);
  });

  it("rejects with a DeviceActionError carrying the app status word", async () => {
    const error = {
      _tag: "EthAppCommandError",
      errorCode: "6985",
      message: "Condition not satisfied",
    };
    const rejection = runDeviceAction(failed(error));
    await expect(rejection).rejects.toBeInstanceOf(DeviceActionError);
    await expect(rejection).rejects.toMatchObject({
      statusCode: 0x6985,
      cause: error,
      message:
        "Device Management Kit signer failed: EthAppCommandError: 6985: Condition not satisfied",
    });
  });

  it("rejects when the action is cancelled", async () => {
    const stopped: DeviceActionRun<never> = {
      observable: new Observable((subscriber) => {
        subscriber.next({ status: DeviceActionStatus.Stopped });
      }),
      cancel() {},
    };
    await expect(runDeviceAction(stopped)).rejects.toThrow("cancelled");
  });
});

describe("hex helpers", () => {
  it("hexToBytes accepts an optional 0x prefix and rejects odd lengths", () => {
    expect(hexToBytes("0x0102")).toEqual(new Uint8Array([1, 2]));
    expect(hexToBytes("0102")).toEqual(new Uint8Array([1, 2]));
    expect(() => hexToBytes("0x123")).toThrow("even-length");
  });

  it("toEvmTransactionSignature pads v to whole bytes like hw-app-eth", () => {
    expect(toEvmTransactionSignature({ r: R, s: S, v: 1 })).toEqual({
      r: "11".repeat(32),
      s: "22".repeat(32),
      v: "01",
    });
    expect(toEvmTransactionSignature({ r: R, s: S, v: 86263 }).v).toBe(
      "0150f7",
    );
  });
});

describe("AvalancheApp EVM methods through the DMK signer", () => {
  it("refuses EVM calls without a DMK session, before touching the device", async () => {
    const transport = new FakeTransport();
    const app = new AvalancheApp(transport);
    await expect(app.signEVMTransaction(PATH, "0x00")).rejects.toThrow(
      "construct AvalancheApp with { dmk, sessionId }",
    );
    expect(transport.calls).toHaveLength(0);
    expect(SignerEthBuilder).not.toHaveBeenCalled();
  });

  it("builds the signer from the session once, honouring originToken and contextModule", async () => {
    const contextModule = {} as NonNullable<EvmSignerOptions["contextModule"]>;
    const app = new AvalancheApp(new FakeTransport(), {
      ...evm,
      originToken: "zondax",
      contextModule,
    });
    mockSigner.getAddress.mockReturnValue(
      completed({ publicKey: "04ab", address: "0xAbC" }),
    );
    await app.getETHAddress(PATH);
    await app.getETHAddress(PATH);
    expect(SignerEthBuilder).toHaveBeenCalledTimes(1);
    expect(SignerEthBuilder).toHaveBeenCalledWith({
      dmk: evm.dmk,
      sessionId: evm.sessionId,
      originToken: "zondax",
    });
    expect(mockWithContextModule).toHaveBeenCalledWith(contextModule);
  });

  it("signs a transaction with the app already open and maps the signature", async () => {
    const app = new AvalancheApp(new FakeTransport(), evm);
    mockSigner.signTransaction.mockReturnValue(completed({ r: R, s: S, v: 1 }));

    const signature = await app.signEVMTransaction(PATH, "0x02c0");

    expect(mockSigner.signTransaction).toHaveBeenCalledWith(
      "44'/60'/0'/0/0",
      new Uint8Array([0x02, 0xc0]),
      { skipOpenApp: true },
    );
    expect(signature).toEqual({
      r: "11".repeat(32),
      s: "22".repeat(32),
      v: "01",
    });
  });

  it("clearSignTransaction is the same call as signEVMTransaction", async () => {
    const app = new AvalancheApp(new FakeTransport(), evm);
    mockSigner.signTransaction.mockReturnValue(completed({ r: R, s: S, v: 0 }));
    await app.clearSignTransaction(PATH, "c0");
    expect(mockSigner.signTransaction).toHaveBeenCalledWith(
      "44'/60'/0'/0/0",
      new Uint8Array([0xc0]),
      { skipOpenApp: true },
    );
  });

  it("gets an address, optionally showing it and returning the chain code", async () => {
    const app = new AvalancheApp(new FakeTransport(), evm);
    mockSigner.getAddress.mockReturnValue(
      completed({ publicKey: "04ab", address: "0xAbC" }),
    );
    await expect(app.getETHAddress(PATH)).resolves.toEqual({
      publicKey: "04ab",
      address: "0xAbC",
    });
    expect(mockSigner.getAddress).toHaveBeenLastCalledWith("44'/60'/0'/0/0", {
      checkOnDevice: false,
      returnChainCode: false,
      skipOpenApp: true,
    });

    mockSigner.getAddress.mockReturnValue(
      completed({ publicKey: "04ab", address: "0xAbC", chainCode: "cc" }),
    );
    await expect(app.getETHAddress(PATH, true, true)).resolves.toEqual({
      publicKey: "04ab",
      address: "0xAbC",
      chainCode: "cc",
    });
    expect(mockSigner.getAddress).toHaveBeenLastCalledWith("44'/60'/0'/0/0", {
      checkOnDevice: true,
      returnChainCode: true,
      skipOpenApp: true,
    });
  });

  it("signs typed data through the signer and keeps v numeric", async () => {
    const app = new AvalancheApp(new FakeTransport(), evm);
    mockSigner.signTypedData.mockReturnValue(completed({ r: R, s: S, v: 28 }));
    const typedData = {
      domain: { name: "Test", chainId: 43114 },
      types: { Mail: [{ name: "to", type: "address" }] },
      primaryType: "Mail",
      message: { to: "0x0000000000000000000000000000000000000001" },
    };
    await expect(app.signEIP712Message(PATH, typedData)).resolves.toEqual({
      r: "11".repeat(32),
      s: "22".repeat(32),
      v: 28,
    });
    expect(mockSigner.signTypedData).toHaveBeenCalledWith(
      "44'/60'/0'/0/0",
      typedData,
      { skipOpenApp: true },
    );
  });

  it("surfaces a device rejection as a DeviceActionError with statusCode 0x6985", async () => {
    const app = new AvalancheApp(new FakeTransport(), evm);
    mockSigner.signTransaction.mockReturnValue(
      failed({ _tag: "EthAppCommandError", errorCode: "6985" }),
    );
    await expect(app.signEVMTransaction(PATH, "c0")).rejects.toMatchObject({
      name: "DeviceActionError",
      statusCode: 0x6985,
    });
  });
});

describe("AvalancheApp EVM APDUs still sent by hand", () => {
  it("getAppConfiguration reads flags and version like hw-app-eth", async () => {
    const transport = new FakeTransport("030104169000");
    const app = new AvalancheApp(transport);
    await expect(app.getAppConfiguration()).resolves.toEqual({
      arbitraryDataEnabled: 1,
      erc20ProvisioningNecessary: 2,
      starkEnabled: 0,
      starkv2Supported: 0,
      version: "1.4.22",
    });
    expect(transport.calls[0]).toMatchObject({
      cla: 0xe0,
      ins: 0x06,
      p1: 0,
      p2: 0,
    });
  });

  it("provideERC20TokenInformation returns false when the app does not know the instruction", async () => {
    const transport = new FakeTransport("9000", "6d00");
    const app = new AvalancheApp(transport);
    const args = [
      "AVAX",
      "Wrapped AVAX",
      "0x" + "ab".repeat(20),
      18,
      43114,
    ] as const;
    await expect(app.provideERC20TokenInformation(...args)).resolves.toBe(true);
    await expect(app.provideERC20TokenInformation(...args)).resolves.toBe(
      false,
    );
    const call = transport.calls[0];
    expect(call).toMatchObject({
      cla: 0xe0,
      ins: 0x0a,
      statusList: [0x9000, 0x6d00],
    });
    // len(ticker) ticker len(name) name address(20) decimals(4) chainId(4)
    expect(call?.data?.length).toBe(1 + 4 + 1 + 12 + 20 + 4 + 4);
    expect(call?.data?.readUInt32BE(1 + 4 + 1 + 12 + 20)).toBe(18);
    expect(call?.data?.readUInt32BE(1 + 4 + 1 + 12 + 20 + 4)).toBe(43114);
  });

  it("setPlugin tolerates the three status words hw-app-eth tolerated", async () => {
    const transport = new FakeTransport("6a80", "6984", "6d00", "9000");
    const app = new AvalancheApp(transport);
    const args = ["0x" + "ab".repeat(20), "0x12345678", 43114n] as const;
    await expect(app.setPlugin(...args)).resolves.toBe(false);
    await expect(app.setPlugin(...args)).resolves.toBe(false);
    await expect(app.setPlugin(...args)).resolves.toBe(false);
    await expect(app.setPlugin(...args)).resolves.toBe(true);
    expect(transport.calls[0]).toMatchObject({
      cla: 0xe0,
      ins: 0x16,
      statusList: [0x9000, 0x6a80, 0x6984, 0x6d00],
    });
  });

  it("provideNFTInformation sends INS 0x14 and tolerates 0x6d00", async () => {
    const transport = new FakeTransport("6d00");
    const app = new AvalancheApp(transport);
    await expect(
      app.provideNFTInformation("Punks", "0x" + "cd".repeat(20), 43114n),
    ).resolves.toBe(false);
    expect(transport.calls[0]).toMatchObject({
      cla: 0xe0,
      ins: 0x14,
      statusList: [0x9000, 0x6d00],
    });
  });

  it("signEIP712HashedMessage lays out path + domain hash + struct hash and parses v/r/s", async () => {
    const transport = new FakeTransport(
      "1b" + "33".repeat(32) + "44".repeat(32) + "9000",
    );
    const app = new AvalancheApp(transport);
    const domain = "0x" + "aa".repeat(32);
    const struct = "bb".repeat(32);

    await expect(
      app.signEIP712HashedMessage("44'/60'/0'/0/0", domain, struct),
    ).resolves.toEqual({ v: 0x1b, r: "33".repeat(32), s: "44".repeat(32) });

    const call = transport.calls[0];
    expect(call).toMatchObject({ cla: 0xe0, ins: 0x0c, p1: 0, p2: 0 });
    expect(call?.data?.length).toBe(1 + 5 * 4 + 32 + 32);
    expect(call?.data?.readUInt8(0)).toBe(5);
    expect(call?.data?.readUInt32BE(1)).toBe(0x8000002c);
    expect(call?.data?.subarray(21, 53).toString("hex")).toBe("aa".repeat(32));
    expect(call?.data?.subarray(53).toString("hex")).toBe("bb".repeat(32));
  });

  it("signEIP712HashedMessage rejects hashes that are not 32 bytes", async () => {
    const app = new AvalancheApp(new FakeTransport());
    await expect(
      app.signEIP712HashedMessage(PATH, "0xaabb", "cc".repeat(32)),
    ).rejects.toThrow("32 bytes");
  });

  it("signPersonalMessage lays out path + length + message on INS 0x08 without a DMK session", async () => {
    const transport = new FakeTransport(
      "1c" + "33".repeat(32) + "44".repeat(32) + "9000",
    );
    const app = new AvalancheApp(transport);
    const message = Buffer.from("Hello Avalanche");

    await expect(
      app.signPersonalMessage("44'/60'/0'/0/0", "0x" + message.toString("hex")),
    ).resolves.toEqual({ v: 0x1c, r: "33".repeat(32), s: "44".repeat(32) });

    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0];
    expect(call).toMatchObject({ cla: 0xe0, ins: 0x08, p1: 0x00, p2: 0x00 });
    // same bytes hw-app-eth's signPersonalMessage sends
    expect(call?.data?.toString("hex")).toBe(
      "05" +
        "8000002c" +
        "8000003c" +
        "80000000" +
        "00000000" +
        "00000000" +
        "0000000f" +
        message.toString("hex"),
    );
    expect(SignerEthBuilder).not.toHaveBeenCalled();
  });

  it("signPersonalMessage splits a long message, P1 0x00 first and 0x80 after", async () => {
    const transport = new FakeTransport(
      "9000",
      "9000",
      "1b" + "33".repeat(32) + "44".repeat(32) + "9000",
    );
    const app = new AvalancheApp(transport);
    const message = Buffer.alloc(600, 0x41);

    await expect(
      app.signPersonalMessage(PATH, message.toString("hex")),
    ).resolves.toEqual({ v: 0x1b, r: "33".repeat(32), s: "44".repeat(32) });

    // path (21) + length (4) + message (600) = 625 bytes in 250-byte chunks
    expect(
      transport.calls.map((call) => [call.ins, call.p1, call.data?.length]),
    ).toEqual([
      [0x08, 0x00, 250],
      [0x08, 0x80, 250],
      [0x08, 0x80, 125],
    ]);
    const payload = Buffer.concat(
      transport.calls.map((call) => new Uint8Array(call.data ?? [])),
    );
    expect(payload.readUInt32BE(21)).toBe(600);
    expect(payload.subarray(25).equals(new Uint8Array(message))).toBe(true);
  });

  it("signPersonalMessage refuses a message that is not hex, before touching the device", async () => {
    const transport = new FakeTransport();
    const app = new AvalancheApp(transport);
    await expect(app.signPersonalMessage(PATH, "Hello!")).rejects.toThrow(
      "even-length hex",
    );
    expect(transport.calls).toHaveLength(0);
  });

  it("signPersonalMessage rejects a response too short to hold v/r/s", async () => {
    const app = new AvalancheApp(new FakeTransport("1b9000"));
    await expect(app.signPersonalMessage(PATH, "00")).rejects.toThrow(
      "Malformed personal message signature response",
    );
  });
});
