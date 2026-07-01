import { notarize } from "@electron/notarize";

export default async function notarizeMac(context) {
  if (process.platform !== "darwin") return;
  if (!context.electronPlatformName || context.electronPlatformName !== "darwin") {
    return;
  }

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appleIdPassword || !teamId) {
    console.log("Skipping macOS notarization because Apple notarization credentials are not configured.");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  await notarize({
    appBundleId: context.packager.appInfo.appId,
    appPath: `${context.appOutDir}/${appName}.app`,
    appleId,
    appleIdPassword,
    teamId,
  });
}
