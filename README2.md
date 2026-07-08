# VPS Setup Guide for Remote Browser

This guide will walk you through setting up the remote browser project on a fresh Virtual Private Server (VPS) running Ubuntu (20.04 / 22.04 / 24.04).

## Prerequisites

- A fresh Ubuntu VPS
- SSH access to your VPS

## Step 1: Install Node.js
The project requires Node.js (version 20 or higher is recommended).
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## Step 2: Transfer the Project Files
Upload the project folder to your VPS. You can use tools like `scp`, `rsync`, SFTP, or Git if you have the code in a repository.

For example, using `scp` from your local machine:
```bash
# Run this on your local machine
scp -r /path/to/my-code user@YOUR_VPS_IP:~
```

## Step 3: Install NPM Packages, Browser, and System Dependencies
SSH into your VPS, navigate to the project directory, and install the required Node dependencies, the Chrome browser, and Playwright's system libraries.

```bash
# Run these on your VPS
cd ~/my-code
npm install
npx playwright install chrome
npx playwright install-deps chrome
```
*(This downloads Google Chrome and automatically installs any missing Ubuntu system dependencies)*

## Step 4: Start the Server
Now you can start the remote browser server.

```bash
npm start
```
*(This executes `node src/server/main.js`)*

The server should now be listening. By default, it will be available on port `3000`.
You can optionally specify a custom port by setting the `PORT` environment variable:
```bash
PORT=80 npm start
```

## Step 5: Access the Browser
Open your mobile browser (or any browser) and navigate to:
`http://YOUR_VPS_IP:3000` (or whichever port you specified)

---

## Persistent Sessions & Manual Logins
The application saves your browser cookies and login states to a local `auth.json` file and a `browser_profile/` directory.

If you want to easily log into websites *before* running the server headless on your VPS, you can:
1. Run `node setup.js` on your **local machine** (this opens a visible Chrome window).
2. Log into Facebook, Instagram, or any websites.
3. Close the browser (which automatically saves `auth.json`).
4. Upload the generated `auth.json` file and `browser_profile/` directory to the VPS alongside the rest of your code.
5. When `npm start` runs on the VPS, it will automatically load your sessions!

---

## Optional: Run as a Persistent Background Service
If you want the server to keep running even after you close your SSH session, or automatically start on server reboot, you can use PM2.

```bash
# Install PM2 globally
sudo npm install -g pm2

# Start the application with PM2
pm2 start npm --name "remote-browser" -- start

# Configure PM2 to start on boot
pm2 startup
pm2 save
```

## Optional: Open Firewall Port
If you have a firewall enabled on your VPS (like UFW), ensure that port 3000 is open so you can access the web interface.
```bash
sudo ufw allow 3000/tcp
```
