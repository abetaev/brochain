import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AccountService } from "./accounts/service";
import type { AccountRepository, StoredAccount } from "./accounts/types";
import { App } from "./App";
import type { DiscoveredPeer, IncomingPeerPacket, PeerNetworkController } from "./network/client";
import type { PeerPacket } from "./network/protocol";

class MemoryAccountRepository implements AccountRepository {
  private readonly accounts = new Map<string, StoredAccount>();

  async list() {
    return [...this.accounts.values()];
  }

  async get(id: string) {
    return this.accounts.get(id);
  }

  async put(account: StoredAccount) {
    this.accounts.set(account.id, account);
  }

  async delete(id: string) {
    this.accounts.delete(id);
  }
}

class TestPeerNetwork implements PeerNetworkController {
  readonly sentTexts: string[] = [];
  private listener: ((packet: IncomingPeerPacket) => void) | undefined;

  onPacket(listener: (packet: IncomingPeerPacket) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  async start() {}

  async stop() {}

  async peers(): Promise<DiscoveredPeer[]> {
    return [
      {
        peerId: "peer-bea",
        name: "Bea",
        addresses: ["/dns4/relay.example/tcp/9090/ws/p2p/relay/p2p-circuit/webrtc/p2p/peer-bea"],
      },
    ];
  }

  async connect() {}

  async connectDirect(address: string): Promise<DiscoveredPeer> {
    return { peerId: "direct-peer", name: "Direct peer", addresses: [address] };
  }

  async sendText(_peer: DiscoveredPeer, text: string): Promise<PeerPacket> {
    this.sentTexts.push(text);
    return { type: "text", id: "message-1", sentAt: "2026-08-02T00:00:00.000Z", text };
  }

  async sendFile(): Promise<PeerPacket> {
    return {
      type: "file",
      id: "file-1",
      sentAt: "2026-08-02T00:00:00.000Z",
      name: "note.txt",
      mediaType: "text/plain",
      data: "",
    };
  }
}

describe("App", () => {
  it("shows the create-account view when no account exists", async () => {
    render(() => <App accountService={new AccountService(new MemoryAccountRepository())} />);

    expect(await screen.findByRole("heading", { name: "Create an account" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
    expect(screen.getByLabelText("Account name")).toBeRequired();
    expect(screen.getByLabelText("Confirm password")).toBeRequired();
  });

  it("creates and unlocks a local account", async () => {
    const user = userEvent.setup();
    const peerNetwork = new TestPeerNetwork();
    render(() => (
      <App
        accountService={new AccountService(new MemoryAccountRepository())}
        createPeerNetwork={() => peerNetwork}
      />
    ));

    await screen.findByRole("heading", { name: "Create an account" });
    await user.type(screen.getByLabelText("Account name"), "Ada");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Confirm password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("heading", { name: "Choose an account" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use" }));
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Unlock account" }));

    expect(await screen.findByRole("heading", { name: "Welcome, Ada" })).toBeInTheDocument();
    expect(await screen.findByText("Bea")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("heading", { name: "Chat with Bea" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Message"), "Hello Bea");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(peerNetwork.sentTexts).toEqual(["Hello Bea"]);
    await user.type(
      screen.getByLabelText("Peer multiaddress"),
      "/dns4/relay.example/tcp/9090/ws/p2p/relay/p2p-circuit/webrtc/p2p/direct-peer",
    );
    await user.click(screen.getByRole("button", { name: "Connect directly" }));
    expect(await screen.findByRole("heading", { name: "Chat with Direct peer" })).toBeInTheDocument();
  });
});
