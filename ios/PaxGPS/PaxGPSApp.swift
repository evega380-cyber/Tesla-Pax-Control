import SwiftUI
import CoreLocation
import Security

// Pax Control iPhone GPS Companion — development prototype.
// Requires iOS app target with Background Modes > Location updates,
// NSLocationWhenInUseUsageDescription and NSLocationAlwaysAndWhenInUseUsageDescription.
// This app must be tested on a physical iPhone. Never commit a real API token.

@MainActor
final class ShiftLocationManager: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var isSharing = false
    @Published var status = "Not sharing"
    @Published var serverURL = "https://tesla-pax-control-production.up.railway.app"
    @Published var token = ""
    @Published var lastSent: Date?

    private let manager = CLLocationManager()
    private var shiftId: String?
    private var lastAttempt = Date.distantPast
    private var pendingLocation: CLLocation?
    private var sending = false

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 30
        manager.pausesLocationUpdatesAutomatically = false
        manager.allowsBackgroundLocationUpdates = true
        token = Self.readToken()
    }

    func saveToken() {
        guard !token.isEmpty else { return }
        let data = Data(token.utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrAccount as String: "pax-gps-token"]
        SecItemDelete(query as CFDictionary)
        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(insert as CFDictionary, nil)
    }

    private static func readToken() -> String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrAccount as String: "pax-gps-token",
                                    kSecReturnData as String: true,
                                    kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }

    private func request(_ path: String, payload: [String: Any] = [:]) async throws -> [String: Any] {
        guard let base = URL(string: serverURL),
              base.scheme == "https",
              let url = URL(string: path, relativeTo: base)?.absoluteURL,
              url.host == base.host else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 15
        req.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    func startShift() async {
        guard !token.isEmpty else { status = "Enter your driver GPS token"; return }
        guard CLLocationManager.locationServicesEnabled() else { status = "Enable Location Services"; return }
        saveToken()
        manager.requestAlwaysAuthorization()
        guard manager.authorizationStatus == .authorizedAlways else {
            status = "Allow Always location access in iPhone Settings, then try again"
            return
        }
        do {
            let response = try await request("/api/gps/shift/start")
            guard let id = response["shiftId"] as? String else { throw URLError(.cannotParseResponse) }
            shiftId = id
            isSharing = true
            status = "Sharing location"
            manager.startUpdatingLocation()
        } catch {
            status = "Unable to start shift: \(error.localizedDescription)"
        }
    }

    func stopShift() async {
        // Stop collecting immediately, even if network is unavailable.
        manager.stopUpdatingLocation()
        isSharing = false
        pendingLocation = nil
        do {
            _ = try await request("/api/gps/shift/stop")
            shiftId = nil
            status = "Shift ended"
        } catch {
            // Server may still consider the shift active until a stop request succeeds.
            status = "Location stopped on phone; server stop failed. Retry End Shift."
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if isSharing && manager.authorizationStatus != .authorizedAlways {
            manager.stopUpdatingLocation()
            isSharing = false
            status = "Location permission changed; sharing stopped on phone"
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        status = "GPS unavailable: \(error.localizedDescription)"
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard isSharing, let loc = locations.last, loc.horizontalAccuracy >= 0 else { return }
        pendingLocation = loc
        guard !sending, Date().timeIntervalSince(lastAttempt) >= 10 else { return }
        lastAttempt = Date()
        sending = true
        Task {
            defer { sending = false }
            guard let location = pendingLocation, let id = shiftId else { return }
            pendingLocation = nil
            var payload: [String: Any] = [
                "shiftId": id,
                "latitude": location.coordinate.latitude,
                "longitude": location.coordinate.longitude,
                "accuracy": location.horizontalAccuracy,
                "timestamp": location.timestamp.timeIntervalSince1970 * 1000
            ]
            if location.course >= 0 { payload["heading"] = location.course }
            do {
                _ = try await request("/api/gps/location", payload: payload)
                lastSent = Date()
                status = "Sharing location"
            } catch {
                status = "GPS update failed; will retry when location changes"
            }
        }
    }
}

struct ContentView: View {
    @StateObject private var gps = ShiftLocationManager()
    @State private var showingToken = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Shift") {
                    Label(gps.status, systemImage: gps.isSharing ? "location.fill" : "location.slash")
                    if let last = gps.lastSent {
                        Text("Last sent: \(last.formatted(date: .omitted, time: .standard))")
                    }
                    if gps.isSharing {
                        Button("End Shift", role: .destructive) {
                            Task { await gps.stopShift() }
                        }
                    } else {
                        Button("Start Shift") {
                            Task { await gps.startShift() }
                        }
                    }
                }
                Section("Connection") {
                    TextField("HTTPS server URL", text: $gps.serverURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    Group {
                        if showingToken {
                            TextField("GPS driver token", text: $gps.token)
                        } else {
                            SecureField("GPS driver token", text: $gps.token)
                        }
                    }
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    Toggle("Show token", isOn: $showingToken)
                    Button("Save token securely") { gps.saveToken() }
                }
                Section {
                    Text("Your location is shared only while a shift is active. iOS background tracking requires Always location permission. Force-quitting the app may stop updates.")
                        .font(.footnote)
                }
            }
            .navigationTitle("Pax GPS")
        }
    }
}

@main
struct PaxGPSApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
