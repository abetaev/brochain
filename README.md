brochain
========

Private peer-to-peer communication.

using brochain
--------------

1. Create an account, or choose a stored account and unlock it. Usernames contain 1–64 lowercase English letters; password strength is advisory.
2. After sign-in, the Session attempts to connect to the default Beacon and Home requests a fresh peer list through connected peers. Beacon appears as an ordinary connected peer. Home refreshes when local connections change; use **Refresh peers** to request new remote Discovery results. If Beacon is unavailable, local peer networking remains usable, and **Retry bootstrap** or **Refresh peers** retries it.
3. Discovered peers remain disconnected until you select **Connect**. You may also enter a peer multiaddress under **Connect directly**.
4. **Chat** is available only for a connected peer that provides messaging. Text and files appear immediately when sent; delivery and read confirmations are not available yet.
5. Incoming messages remain available across views while you are signed in. Home marks peers with unread messages, and opening Chat clears that marker. Messages and received-file links disappear after sign-out or page reload and are not delivered while the application is closed or offline.
6. The Account view can export an encrypted account record or permanently delete a local account after password confirmation.
