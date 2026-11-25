# Android app

The Android app is a thin [Capacitor](https://capacitorjs.com) shell (`android-app/`). On first run it asks for your
hub URL, checks that the hub answers, and stores the URL. From then on it opens the web app served by your hub, with
native push notifications. Pairing happens in the web app, the same way as in a browser.

Push notifications go through Firebase Cloud Messaging (FCM). You need a free Firebase project and three files that
never go into git:

| File | Where | Used by |
| --- | --- | --- |
| `google-services.json` | `~/.config/quorum/android/` on the build machine | `make apk` |
| `release.keystore` and `keystore.properties` | `~/.config/quorum/android/` on the build machine | `make apk` (signing) |
| `fcm.json` (service account key) | `~/.config/quorum/fcm.json` on the hub host | `quorum-hub` (sends pushes) |

Without `fcm.json` the hub works as before and logs once that push is off.

## 1. Firebase

1. **Create the project.** Open the [Firebase console](https://console.firebase.google.com), click
   **Create a project**, give it a name (for example `quorum`) and finish the wizard. Google Analytics is not needed.
2. **Add the Android app.** In the project overview, click the Android icon (**Add app**). Enter the package name
   `dev.quorum.app` exactly. The nickname is optional and the SHA-1 is not needed. Click **Register app**.
3. **Download `google-services.json`.** The next step of the wizard offers the file. Save it on the machine that builds
   the APK:

   ```sh
   mkdir -p ~/.config/quorum/android
   chmod 700 ~/.config/quorum/android
   mv ~/Downloads/google-services.json ~/.config/quorum/android/
   ```

   Skip the remaining wizard steps (the build already applies the Google services plugin). You can download the file
   again later from **Project settings > General > Your apps**.
4. **Create the service account key for the hub.** Open **Project settings > Service accounts** and click
   **Manage service account permissions** (this opens Google Cloud IAM for the same project). Then:
   1. **Create service account**, name it `quorum-hub`, click **Create and continue**.
   2. Grant the role **Firebase Cloud Messaging API Admin**, then **Done**.
   3. Open the new account, go to **Keys > Add key > Create new key**, choose **JSON**, and download it.
   4. Copy the key to the hub host as `~/.config/quorum/fcm.json` and restrict it:

      ```sh
      scp quorum-hub-key.json vps-1:.config/quorum/fcm.json
      ssh vps-1 'chmod 600 ~/.config/quorum/fcm.json && systemctl --user restart quorum-hub'
      ```

      Delete the downloaded copy afterwards.
5. **Enable the FCM HTTP v1 API.** In **Project settings > Cloud Messaging**, check that
   **Firebase Cloud Messaging API (V1)** says **Enabled**. If it does not, open the menu next to it and enable it (or
   enable **Firebase Cloud Messaging API** in Google Cloud **APIs & Services > Library**). The legacy API is not used.

## 2. Signing key

Android only installs signed APKs, and updates must be signed with the same key. Generate it once and keep a backup:
if you lose it, you must uninstall the app before installing a build signed with a new key.

```sh
keytool -genkeypair -v -keystore ~/.config/quorum/android/release.keystore \
  -alias quorum -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Quorum"
```

`keytool` asks for a password. Then write `~/.config/quorum/android/keystore.properties` with that password:

```properties
storePassword=<the keystore password>
keyAlias=quorum
keyPassword=<the key password; the same as storePassword unless you chose another>
```

```sh
chmod 600 ~/.config/quorum/android/release.keystore ~/.config/quorum/android/keystore.properties
```

## 3. Build

The build needs Node.js, a **JDK 21** (Capacitor 8 compiles with Java 21) and the Android SDK command-line tools:

```sh
# JDK 21: any distribution works, for example Eclipse Temurin unpacked to ~/.jdk21 (make apk looks there first,
# then uses JAVA_HOME).

# Android SDK in ~/Android/sdk (override with ANDROID_HOME=...):
mkdir -p ~/Android/sdk/cmdline-tools
# download "Command line tools only" for Linux from https://developer.android.com/studio#command-tools, then:
unzip commandlinetools-linux-*_latest.zip -d ~/Android/sdk/cmdline-tools
mv ~/Android/sdk/cmdline-tools/cmdline-tools ~/Android/sdk/cmdline-tools/latest
yes | ~/Android/sdk/cmdline-tools/latest/bin/sdkmanager --sdk_root=$HOME/Android/sdk --licenses
~/Android/sdk/cmdline-tools/latest/bin/sdkmanager --sdk_root=$HOME/Android/sdk \
  "platform-tools" "platforms;android-36" "build-tools;35.0.0"
```

Then, from the repository root:

```sh
make apk
```

It checks that the three secret files exist (and names the missing one if not), syncs the Capacitor project, copies
`google-services.json` into the build only for the duration of the build, and writes the signed release APK to
`android-app/quorum.apk` (git-ignored). `QUORUM_ANDROID_SECRETS=<dir>` reads the secrets from another folder.

## 4. Install (sideload)

Either connect the phone with USB debugging on and run:

```sh
~/Android/sdk/platform-tools/adb install -r android-app/quorum.apk
```

or copy `quorum.apk` to the phone (cloud drive, Taildrop, a USB cable) and open it there. Android asks once to allow
installs from that app (**Install unknown apps**). Updates install over the old version as long as they are signed with
the same key.

## 5. First run and pairing

1. Connect the phone to your Tailscale network.
2. Open **Quorum**. Enter the hub URL, for example `http://vps-1:7420` or your `https://<host>.<tailnet>.ts.net`
   address, and tap **Connect**. The app checks `<hub>/api/ping` before it saves the URL.
3. The web app opens from the hub. On the hub host, run `quorum-hub pair` and type the code in the app.
4. Allow notifications when Android asks. The app then registers its push token with the hub. Notifications use the
   **Sessions** channel, which you can tune in Android's app settings.

If the hub cannot be reached when the app starts (for example, Tailscale is off), the app shows
"Can't reach the hub. Is Tailscale connected?" with **Retry** and **Change hub**. The saved URL is kept until you choose
**Change hub** (there or in the web app's settings), which takes you back to the first-run page.

## Notes

- The app allows plain `http` for every host: the hub's address is only known at runtime, and the app only talks to
  your hub over your tailnet, which Tailscale encrypts.
- To revoke the phone, run `quorum-hub revoke device <name>` on the hub. The hub also deletes its push token, so no more
  notifications reach it.
