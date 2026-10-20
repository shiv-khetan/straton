# Windows service

Build with cargo build --release -p straton-engine. Use a service wrapper such as
WinSW to launch straton-engine.exe run from a dedicated working directory
containing straton.toml. The binary is a console application, not an SCM service.
Run the wrapper under a dedicated user account with write access to the data,
backup and log directories. Configure automatic restart on failure and a stop
command that sends Ctrl-C, allowing at least 40 seconds before forced termination.
The engine drains workers for up to 30 seconds. If a wrapper forcibly terminates
it, running runs recover from their last committed checkpoint at startup.

The token is restricted to the current user's SID using Windows ACLs. Clients
must run under that account or receive the token through a secure channel.
Stop the service before running straton-engine restore <snapshot.db> with the
same configuration and account; the data directory lock enforces this.
