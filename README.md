brochain
========

overview
--------

peer-to-peer networking application for communication and content exchange between real people.

using brochain
--------------

- on a device without accounts, create an account with a name and password. The password-strength meter helps assess the chosen password.
- on later visits, choose an account, unlock it with its password, or create another account.
- each account can be exported as an encrypted account file or deleted from the device.
- after unlocking an account, choose a discoverable peer or paste a peer multiaddress to connect directly.
- connected peers can exchange text messages and files. Received files are available for download in the chat.

brochain is a progressive web application. Its application shell can be installed by browsers that support web-app installation; peer discovery and communication require an active network connection.

project's documentation consists of:

- *user documentation* -- this file

  designated for all audiences, provides a high-level overview of implemented project functions

- [technical architecture](ARCHITECTURE.md)

  designated for engineers and AI agents, provides information on technical implementation and decisions

  this document records only already implemented decisions 

- [development plan](BACKLOG.md)

  designated for engineers and AI agents, contains managed list of tasks that need to be implemented

  this document holds unimplemented requirements and provisional decisions

- [development instructions](DEVELOPMENT.md)

  designated for engineers and AI agents, contains instructions on how to develop, test and deploy the project

- [project guidelines](./GUIDELINES.md)

  designated for engineers and AI agents, contains guidelines on coding and documentation style

- [AI agent guidelines](./AGENTS.md)

  designated for AI agents, contains workflow definitions and special instructions for AI agents
