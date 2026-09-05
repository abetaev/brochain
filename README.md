brochain
========

Private peer-to-peer communication.

using brochain
--------------

1. **Sign in.** Create an account, or select an existing one and unlock it.
   Account names use 1–64 lowercase English letters, and the password-strength
   indicator is advice which does not prevent creation. Signing in requires
   browser support for IndexedDB, private file storage, and Web Locks.
2. **Find people.** Home connects to the default Beacon in the background; if it
   is unavailable, sign-in still succeeds and Home shows the failure. The list
   updates as people become available through the Beacon or direct connections,
   and **Refresh peers** retries the Beacon and refreshes connected peers. People
   identified earlier stay listed for that account after a reload, where **Not
   currently available** means they must be found again.
3. **Connect.** Select **Connect** beside a peer. If someone gave you an address
   instead, paste it under **Connect directly**, which takes either a URL such as
   `https://example.com` or a peer multiaddress. That only connects; the peer
   then appears in the list like any other.
4. **Talk.** Select **Chat**, enter text, and select **Send message**. Use **Send
   a file** where file sharing is available for that peer; progress and failures
   appear in the conversation. Both people must be connected to send.
5. **Call.** Select **Call** in a conversation to place an audio and video call,
   available while that peer offers calls. The call appears in the conversation
   itself as a record you can cancel, and an incoming one reaches you wherever you
   are as that peer's avatar in the status bar, leading to the conversation where
   you **Accept call** or **Decline call** — your camera and microphone are only
   taken once you accept. Answering opens the call, which shows both pictures and
   offers muting, stopping your camera, and hanging up; leaving it keeps the call
   running and **Open call** in the conversation leads back. Ending it returns you
   to the conversation, where the record stays, saying the call ended and why if
   something went wrong. A call reaches only a peer on the same local network for
   now, and says so plainly when no media path can be established.
6. **Read.** Whatever is waiting for you appears as that peer's avatar in the
   status bar of every view — unread messages and calls — and Home marks
   conversations holding unread items too. Opening a conversation clears its
   marker. Messages and received files stay available while you are signed in and
   disappear after sign-out or reload.
7. **Yourself.** Select your own avatar in the top bar on Home to name yourself,
   read the peer ID and addresses someone else needs to reach you, and choose
   whether connection requests are accepted without asking. The name is yours
   alone for now; peers still see the account username until they reconnect.
8. **Configure.** Select **Settings** beside a peer, or from a conversation, to
   see what they report about themselves, name them, and choose which services
   they may reach. A peer arrives named by whatever it reports; **Save name**
   replaces that with a name of your own, up to 64 characters, used everywhere it
   appears, and **Reset name** returns to what the peer last reported. **Refresh
   identity** asks them again, and becomes **Clear identity** when they no longer
   share one, after which resetting leaves only their peer ID. Service changes
   apply at once, including while connected. Refusing the registry leaves them no
   way to learn what you support, which bars them entirely.
9. **Sign out** to return to the account screen, where you can export an account
   or permanently delete it after confirming its password.
