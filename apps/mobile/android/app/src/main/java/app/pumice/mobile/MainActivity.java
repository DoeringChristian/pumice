package app.pumice.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The vault's file access (source: apps/mobile/native/android/PumiceFsPlugin.kt).
        registerPlugin(PumiceFsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
