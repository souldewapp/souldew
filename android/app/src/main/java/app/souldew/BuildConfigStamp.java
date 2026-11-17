package app.souldew;

import android.content.Context;
import android.content.pm.PackageInfo;

/** Changes with every installed build, so the unpacked server files are refreshed after an update. */
final class BuildConfigStamp {
    private BuildConfigStamp() {}

    static String version(Context c) {
        try {
            PackageInfo p = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return p.versionName + ":" + p.lastUpdateTime;
        } catch (Exception e) {
            return "0";
        }
    }
}
