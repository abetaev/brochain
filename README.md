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
3. **Connect.** Select **Connect** beside a peer, or paste an address someone
   gave you under **Connect directly**.
4. **Talk.** Select **Chat**, enter text, and select **Send message**. Use **Send
   a file** where file sharing is available for that peer; progress and failures
   appear in the conversation. Both people must be connected to send.
5. **Read.** Home marks conversations holding unread items, and opening one
   clears its marker. Messages and received files stay available while you are
   signed in and disappear after sign-out or reload.
6. **Sign out** to return to the account screen, where you can export an account
   or permanently delete it after confirming its password.
