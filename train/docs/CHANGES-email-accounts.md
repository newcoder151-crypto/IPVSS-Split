# E-mail password reset: nothing to set up

Copy the files from changed-files-8, -9 and -10.zip over your folder, then run:

    bash start.sh

start.sh does everything itself and asks nothing: system tools, PostgreSQL, npm packages, old-file cleanup, databases,
.env files, starting the M-NVR, CMS, RPF and the bridge.

Reset e-mails: the address is taken when an account is created (RPF registration / Add officer, CMS Add user, mNVR sign-up).
"Forgot password?" e-mails a single-use 30-minute link to the address on the account. No SMTP account is needed (mail is
sent straight to the recipient's mail server; check spam). Optional: mail.env to use your own mail server.

Instant delivery: run  bash start.sh mail  once (server name or 'gmail', user, app password, test address). It sends a test mail and prints how long it took.
Without it mail is sent straight to the recipient's server, which can take minutes or land in spam; the server log shows the time of every mail.
