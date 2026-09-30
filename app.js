/*
 * SkyGuard AI dashboard.
 * Uses the existing static HTML/CSS and FastAPI service.
 */
(() => {
    "use strict";

    const API = "http://127.0.0.1:8000";
    const REFRESH_TIME = 15000;
    const HISTORY_LIMIT = 10;

    let stations = [];
    let weather = [];
    let chartPoints = [];
    let healthData = null;
    let latestDetections = new Map();
    let currentDataSource = "Simulated";
    let selectedStation = "ALL";
    let chartMode = "all";
    let darkMode = true;
    let refreshSequence = 0;
    let hasLoadedDashboard = false;
    const hourlyObservationCache = new Map();
    const detectionCache = new Map();

    const $ = id => document.getElementById(id);

    function setText(id, value) {
        const element = $(id);
        if (element) element.textContent = value;
    }

    function formatNumber(value, digits = 1) {
        if (value === null || value === undefined || value === "") return "--";
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed.toFixed(digits) : "--";
    }

    async function api(endpoint, options = {}) {
        const response = await fetch(API + endpoint, options);
        let payload = null;

        try {
            payload = await response.json();
        } catch (_) {
            // Keep the HTTP status as the useful error if the response is not JSON.
        }

        if (!response.ok) {
            const detail = payload && payload.detail;
            throw new Error(detail || ("API error: " + response.status));
        }

        return payload;
    }

    function stationName(id) {
        const station = stations.find(item => item.station_id === id);
        return station ? station.station_name : id;
    }

    function setDashboardState(message, state) {
        const element = $("dashboardStatus");
        if (!element) return;
        element.textContent = message;
        element.classList.remove("is-loading", "is-error", "is-success");
        if (state) element.classList.add("is-" + state);
        const backendStatus = $("backendStatus");
        const backendLabel = $("backendStatusLabel");
        if (backendStatus && backendLabel) {
            backendStatus.classList.remove("status-online", "status-working", "status-error");
            if (state === "loading") {
                backendStatus.classList.add("status-working");
                backendLabel.textContent = "Connecting";
            } else if (state === "error") {
                backendStatus.classList.add("status-error");
                backendLabel.textContent = "Data service issue";
            } else {
                backendStatus.classList.add("status-online");
                backendLabel.textContent = "System Operational";
            }
        }
    }

    function setChartState(message, state) {
        const element = $("chartState");
        if (!element) return;
        element.textContent = message;
        element.classList.remove("is-loading", "is-error", "is-hidden");
        if (state) element.classList.add("is-" + state);
        const canvas = $("trendChart");
        if (canvas) canvas.style.display = state === "loading" || state === "error"
            ? "none"
            : "block";
    }

    function resolveDataSource(payload) {
        const source = String(
            payload.data_source || payload.source || payload.provider || ""
        ).toLowerCase();
        return source.includes("wis2") || source.includes("imd")
            ? "Live IMD WIS2"
            : "Simulated";
    }

    function setDataSource(source) {
        currentDataSource = source;
        const badge = $("dataSourceBadge");
        if (!badge) return;
        const isLive = source === "Live IMD WIS2";
        const isSimulated = source === "Simulated";
        badge.textContent = isLive
            ? "LIVE IMD WIS2"
            : isSimulated ? "SIMULATED" : "DATA UNAVAILABLE";
        badge.classList.toggle("source-live", isLive);
        badge.classList.toggle("source-simulated", isSimulated);
        badge.classList.toggle("source-unavailable", !isLive && !isSimulated);
    }

    function formatObservationTime(value) {
        if (!value) return "Timestamp unavailable";
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return "Timestamp unavailable";
        return new Intl.DateTimeFormat("en-IN", {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
        }).format(date) + " IST";
    }

    function stabilizeSimulatedReadings(records) {
        const visible = [];
        records.forEach(record => {
            const timestamp = new Date(record.timestamp);
            if (!Number.isFinite(timestamp.getTime())) return;
            const hour = Math.floor(timestamp.getTime() / 3600000);
            const key = record.station_id + "|" + hour;
            if (!hourlyObservationCache.has(key)) {
                hourlyObservationCache.set(key, record);
            }
            visible.push(hourlyObservationCache.get(key));
        });

        const cutoff = Date.now() - 26 * 3600000;
        hourlyObservationCache.forEach((record, key) => {
            if (new Date(record.timestamp).getTime() < cutoff) {
                hourlyObservationCache.delete(key);
            }
        });
        return visible;
    }

    function showHealthError(error) {
        healthData = null;
        ["kpiTotalStations", "kpiNormalStations", "kpiActiveAnomalies", "kpiAvgConfidence"]
            .forEach(id => setText(id, "--"));
        setText("kpiSeverityBreakdown", "Health data unavailable");
        setText("alertBadge", "--");
        setText("healthDataSource", "Sensor health unavailable");
        ["healthHealthyCount", "healthWarningCount", "healthFaultCount"]
            .forEach(id => setText(id, "--"));
        ["healthHealthyBar", "healthWarningBar", "healthFaultBar"]
            .forEach(id => { if ($(id)) $(id).style.width = "0%"; });
        const list = $("healthStationList");
        if (list) {
            list.replaceChildren(makeElement(
                "p", "empty-state is-error", "Sensor health unavailable: " + error.message
            ));
        }
    }

    async function loadStations() {
        const data = await api("/stations");
        stations = Array.isArray(data.stations) ? data.stations : [];

        const select = $("stationSelect");
        if (!select) return;

        select.replaceChildren();

        const allOption = document.createElement("option");
        allOption.value = "ALL";
        allOption.textContent = "All Stations (" + stations.length + ")";
        select.appendChild(allOption);

        stations.forEach(station => {
            const option = document.createElement("option");
            option.value = station.station_id;
            option.textContent = station.station_id + " - " + station.station_name;
            select.appendChild(option);
        });

        if (selectedStation !== "ALL" &&
            !stations.some(item => item.station_id === selectedStation)) {
            selectedStation = "ALL";
        }
        select.value = selectedStation;
        updateStationTag();
    }

    function updateStationTag() {
        if (selectedStation === "ALL") {
            setText("currentStationTag", "All stations - latest network average");
        } else {
            setText("currentStationTag", selectedStation + " - " + stationName(selectedStation));
        }
    }

    function observationsForStation(stationId) {
        return weather
            .filter(record => record.station_id === stationId)
            .slice()
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }

    function latestByStation() {
        const latest = new Map();
        weather.forEach(record => {
            const current = latest.get(record.station_id);
            if (!current || record.timestamp > current.timestamp) {
                latest.set(record.station_id, record);
            }
        });
        return Array.from(latest.values());
    }

    function historyFor(record) {
        return observationsForStation(record.station_id)
            .filter(item => item.timestamp < record.timestamp)
            .slice(-HISTORY_LIMIT);
    }

    function average(records, key) {
        const values = records
            .map(record => record[key])
            .filter(value => value !== null && value !== undefined && value !== "")
            .map(Number)
            .filter(value => Number.isFinite(value));
        if (!values.length) return null;
        return values.reduce((sum, value) => sum + value, 0) / values.length;
    }

    function averageDirection(records) {
        const values = records
            .map(record => record.wind_direction_deg)
            .filter(value => value !== null && value !== undefined && value !== "")
            .map(Number)
            .filter(value => Number.isFinite(value));
        if (!values.length) return null;

        const radians = values.map(value => value * Math.PI / 180);
        const sin = radians.reduce((sum, value) => sum + Math.sin(value), 0);
        const cos = radians.reduce((sum, value) => sum + Math.cos(value), 0);
        return (Math.atan2(sin, cos) * 180 / Math.PI + 360) % 360;
    }

    function displayReadings() {
        const selected = selectedStation === "ALL"
            ? weather.slice()
            : observationsForStation(selectedStation);

        if (selectedStation !== "ALL") return selected;

        const byTime = new Map();
        selected.forEach(record => {
            if (!byTime.has(record.timestamp)) byTime.set(record.timestamp, []);
            byTime.get(record.timestamp).push(record);
        });

        return Array.from(byTime.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([timestamp, records]) => ({
                timestamp: timestamp,
                station_id: "ALL",
                temperature_c: average(records, "temperature_c"),
                pressure_hpa: average(records, "pressure_hpa"),
                humidity_pct: average(records, "humidity_pct"),
                wind_speed_ms: average(records, "wind_speed_ms"),
                wind_direction_deg: averageDirection(records),
                rainfall_mm: average(records, "rainfall_mm"),
            }));
    }

    function latestDisplayReading() {
        const records = displayReadings();
        return records.length ? records[records.length - 1] : null;
    }

    async function detect(record, history = historyFor(record)) {
        const key = record.station_id + "|" + record.timestamp;
        if (detectionCache.has(key)) return detectionCache.get(key);

        const payload = Object.assign({}, record, {
            _history: history.slice(-HISTORY_LIMIT)
        });
        const request = api("/detect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        detectionCache.set(key, request);
        try {
            const result = await request;
            detectionCache.set(key, result);
            if (detectionCache.size > 600) {
                const removeCount = detectionCache.size - 400;
                Array.from(detectionCache.keys()).slice(0, removeCount)
                    .forEach(cacheKey => detectionCache.delete(cacheKey));
            }
            return result;
        } catch (error) {
            detectionCache.delete(key);
            throw error;
        }
    }

    function chartReadings() {
        return (selectedStation === "ALL"
            ? displayReadings()
            : observationsForStation(selectedStation)).slice(-24);
    }

    async function analyzeChartReadings(records) {
        return Promise.all(records.map(async (record, index) => {
            const history = records.slice(Math.max(0, index - HISTORY_LIMIT), index);
            try {
                const payload = await detect(record, history);
                return Object.assign({}, record, { detection: payload.detection || null });
            } catch (error) {
                console.error("Chart point detection failed:", record.station_id, error);
                return Object.assign({}, record, { detection: null });
            }
        }));
    }

    async function loadWeather() {
        const requestId = ++refreshSequence;
        let url = "/weather?hours=24";
        if (selectedStation !== "ALL") {
            url += "&station_id=" + encodeURIComponent(selectedStation);
        }

        setDashboardState(
            hasLoadedDashboard ? "Refreshing sensor and detector data..." :
                "Loading station data, detections, and sensor health...",
            "loading"
        );
        setChartState("Loading analyzed chart points...", "loading");
        setText("diagnosticsState", "Loading /detect responses...");
        const diagnosticsState = $("diagnosticsState");
        if (diagnosticsState) {
            diagnosticsState.classList.remove("is-error");
            diagnosticsState.classList.add("is-loading");
        }
        setText("scoreTemporal", "--");
        setText("scoreMultivariate", "--");
        setText("scoreConfidence", "--");
        setText("reasonText", "Loading detector results...");
        const alerts = $("alertsList");
        if (alerts) {
            alerts.replaceChildren(makeElement(
                "p", "empty-state is-loading", "Loading /detect results..."
            ));
        }

        const [weatherResult, healthResult] = await Promise.allSettled([
            api(url),
            api("/health/sensors")
        ]);
        if (requestId !== refreshSequence) return;

        if (healthResult.status === "fulfilled") {
            healthData = healthResult.value;
            updateKPIs(healthData.summary);
            updateSensorHealth(healthData);
        } else {
            console.error("Sensor health refresh failed:", healthResult.reason);
            showHealthError(healthResult.reason);
        }

        if (weatherResult.status === "rejected") {
            const error = weatherResult.reason;
            console.error("Weather refresh failed:", error);
            weather = [];
            chartPoints = [];
            latestDetections = new Map();
            updateTelemetry();
            drawChart();
            updateDiagnostics([], true);
            updateAlerts([], true);
            setDataSource("Unavailable");
            setDashboardState("Weather observations unavailable: " + error.message, "error");
            return;
        }

        const data = weatherResult.value;
        currentDataSource = resolveDataSource(data);
        const received = Array.isArray(data.observations) ? data.observations : [];
        weather = currentDataSource === "Simulated"
            ? stabilizeSimulatedReadings(received)
            : received;
        setDataSource(currentDataSource);
        updateStationTag();

        if (!weather.length) {
            setDataSource("Unavailable");
            chartPoints = [];
            latestDetections = new Map();
            updateTelemetry();
            drawChart();
            updateDiagnostics([]);
            updateAlerts([], false);
            setDashboardState("No observations were returned for this selection.", "error");
            return;
        }

        const pointReadings = chartReadings();
        const latestReadings = latestByStation();
        const [pointResults, analyses] = await Promise.all([
            analyzeChartReadings(pointReadings),
            Promise.all(latestReadings.map(async record => {
                try {
                    return { record, payload: await detect(record) };
                } catch (error) {
                    console.error("Detection failed for " + record.station_id + ":", error);
                    return { record, payload: null };
                }
            }))
        ]);
        if (requestId !== refreshSequence) return;

        chartPoints = pointResults.filter(point => point.detection);
        latestDetections = new Map();
        analyses.forEach(item => {
            if (item.payload && item.payload.detection) {
                latestDetections.set(item.record.station_id, item.payload.detection);
            }
        });

        updateTelemetry();
        drawChart();
        updateDiagnostics(analyses);
        updateAlerts(analyses, false);

        const analyzedPoints = chartPoints.length;
        if (analyzedPoints) {
            hasLoadedDashboard = true;
            setDashboardState(
                "Updated " + formatObservationTime(new Date().toISOString()) +
                    " · " + currentDataSource,
                "success"
            );
            if (healthResult.status === "rejected" ||
                analyses.some(item => !item.payload) ||
                chartPoints.length < pointReadings.length) {
                setDashboardState(
                    "Some observations could not be analyzed by /detect.",
                    "error"
                );
            }
        } else {
            setDashboardState("Chart readings could not be analyzed by /detect.", "error");
        }
    }

    function setStatus(id, label, state) {
        const element = $(id);
        if (!element) return;

        element.textContent = label;
        element.classList.remove("status-good", "status-warning", "status-alert");
        element.classList.add(state === "Fault" || state === "alert"
            ? "status-alert"
            : state === "Warning" || state === "warning" || state === "Unavailable"
                ? "status-warning"
                : "status-good");
    }

    function healthForParameter(parameter) {
        if (!healthData || !Array.isArray(healthData.stations)) return null;
        const candidates = healthData.stations
            .filter(station => selectedStation === "ALL" || station.station_id === selectedStation)
            .map(station => (station.parameters || []).find(item => item.parameter === parameter))
            .filter(Boolean);
        if (!candidates.length) return null;
        const rank = { Fault: 2, Warning: 1, Healthy: 0 };
        return candidates.sort((a, b) =>
            (rank[b.status] || 0) - (rank[a.status] || 0) ||
            b.frozen_value_run_length - a.frozen_value_run_length
        )[0];
    }

    function detectionForSelectedView() {
        if (selectedStation !== "ALL") return latestDetections.get(selectedStation) || null;
        return chartPoints.length ? chartPoints[chartPoints.length - 1].detection : null;
    }

    function parameterHasAnomaly(detection, parameter) {
        if (!detection) return false;
        const evidence = (detection.explanation || [])
            .find(item => item.parameter === parameter);
        if (!evidence) return false;
        if (evidence.rule_triggered || (evidence.temporal_reasons || []).length) return true;
        return Boolean(detection.ml_is_anomaly && evidence.z_score !== null &&
            evidence.z_score !== undefined && Math.abs(Number(evidence.z_score)) >= 2);
    }

    function rangeText(records, key, unit, digits = 1) {
        const values = records
            .filter(record => record[key] !== null && record[key] !== undefined && record[key] !== "")
            .map(record => Number(record[key]))
            .filter(Number.isFinite);
        if (!values.length) return "24-hour range: unavailable";
        return "24-hour range: " + Math.min(...values).toFixed(digits) + " - " +
            Math.max(...values).toFixed(digits) + " " + unit;
    }

    function updateTelemetry() {
        const record = latestDisplayReading();
        const records = displayReadings();
        if (!record) {
            ["valTemp", "valPress", "valHum", "valWind", "valRain"]
                .forEach(id => setText(id, "--"));
            ["statusTemp", "statusPress", "statusHum", "statusWind", "statusRain"]
                .forEach(id => setStatus(id, "Unavailable", "warning"));
            setText("observationTimestamp", "Timestamp unavailable");
            return;
        }

        setText("valTemp", formatNumber(record.temperature_c));
        setText("valPress", formatNumber(record.pressure_hpa));
        setText("valHum", formatNumber(record.humidity_pct));
        setText("valWind", formatNumber(record.wind_speed_ms));
        setText("valRain", formatNumber(record.rainfall_mm));
        setText("observationTimestamp", formatObservationTime(record.timestamp));
        const timestamp = $("observationTimestamp");
        if (timestamp) timestamp.dateTime = record.timestamp || "";

        setText("tempRange", rangeText(records, "temperature_c", "\u00b0C"));
        setText("pressureRange", rangeText(records, "pressure_hpa", "hPa"));
        setText("humidityHealthHint", rangeText(records, "humidity_pct", "%"));
        const rainValues = records
            .filter(item => item.rainfall_mm !== null && item.rainfall_mm !== undefined && item.rainfall_mm !== "")
            .map(item => Number(item.rainfall_mm))
            .filter(Number.isFinite);
        setText("rainTotal", rainValues.length
            ? "24-hour total: " + rainValues.reduce((sum, value) => sum + value, 0).toFixed(1) + " mm"
            : "24-hour total: unavailable");

        if ($("valWindDir")) {
            setText("valWindDir", "Direction: " + formatNumber(record.wind_direction_deg) + "\u00b0");
        }

        const detection = detectionForSelectedView();
        const healthStatus = parameter => {
            const health = healthForParameter(parameter);
            return health ? health.status : "Unavailable";
        };
        const statusFor = (elementId, parameter, value) => {
            if (value === null || value === undefined || value === "") {
                setStatus(elementId, "Missing", "Fault");
            } else if (parameterHasAnomaly(detection, parameter)) {
                setStatus(elementId, "Anomaly", "Fault");
            } else {
                const status = healthStatus(parameter);
                setStatus(elementId, status, status);
            }
        };
        statusFor("statusTemp", "temperature_c", record.temperature_c);
        statusFor("statusPress", "pressure_hpa", record.pressure_hpa);
        statusFor("statusWind", "wind_speed_ms", record.wind_speed_ms);
        statusFor("statusRain", "rainfall_mm", record.rainfall_mm);

        const humidityHealth = healthForParameter("humidity_pct");
        const humidityValue = Number(record.humidity_pct);
        const frozenRun = humidityHealth
            ? Number(humidityHealth.frozen_value_run_length) || 0
            : 0;
        if (Number.isFinite(humidityValue) && humidityValue >= 99.95 &&
            currentDataSource === "Simulated") {
            const isFrozen = frozenRun >= 4;
            setStatus(
                "statusHum",
                isFrozen ? "Frozen at 100% cap" : "At simulated 100% cap",
                isFrozen ? "Fault" : "Warning"
            );
            setText("humidityHealthHint", isFrozen
                ? "Simulated humidity is capped at 100%; " + frozenRun +
                    " consecutive readings are flagged as frozen."
                : "Simulated humidity reached its 100% cap; the raw value is shown.");
        } else if (humidityHealth && frozenRun >= 4) {
            setStatus("statusHum", "Frozen run: " + frozenRun, "Fault");
            setText("humidityHealthHint", "Sensor-health data reports " + frozenRun +
                " consecutive unchanged readings.");
        } else {
            statusFor("statusHum", "humidity_pct", record.humidity_pct);
        }
    }

    function updateKPIs(summary) {
        if (!summary) return;
        const breakdown = summary.severity_breakdown || {};
        const averageConfidence = summary.average_confidence;

        setText("kpiTotalStations", summary.total_stations ?? "--");
        setText("kpiActiveAnomalies", summary.active_anomalies ?? "--");
        setText("alertBadge", summary.active_anomalies ?? "--");
        setText("kpiNormalStations", summary.normal_stations ?? "--");
        setText(
            "kpiSeverityBreakdown",
            (breakdown.critical || 0) + " Critical, " +
            (breakdown.high || 0) + " High, " +
            (breakdown.medium || 0) + " Medium, " +
            (breakdown.low || 0) + " Low"
        );
        setText(
            "kpiAvgConfidence",
            averageConfidence === null || averageConfidence === undefined
                ? "--"
                : formatNumber(averageConfidence * 100) + "%"
        );
    }

    function updateSensorHealth(data) {
        const summary = data.summary || {};
        const healthy = Number(summary.healthy_sensors) || 0;
        const warning = Number(summary.warning_sensors) || 0;
        const fault = Number(summary.fault_sensors) || 0;
        const total = Number(summary.total_sensors) || 0;
        const percent = value => total ? value / total * 100 : 0;

        const healthyBar = $("healthHealthyBar");
        const warningBar = $("healthWarningBar");
        const faultBar = $("healthFaultBar");
        if (healthyBar) healthyBar.style.width = percent(healthy) + "%";
        if (warningBar) warningBar.style.width = percent(warning) + "%";
        if (faultBar) faultBar.style.width = percent(fault) + "%";

        setText("healthHealthyCount", healthy);
        setText("healthWarningCount", warning);
        setText("healthFaultCount", fault);
        setText("healthDataSource", data.data_source === "wis2"
            ? "24 h window - Live WIS2 observations"
            : "24 h window - Generated fallback (no recent WIS2 readings)");

        const container = $("healthStationList");
        if (!container) return;
        container.replaceChildren();

        (data.stations || []).forEach(station => {
            const status = String(station.status || "Warning").toLowerCase();
            const details = document.createElement("details");
            details.className = "health-station";

            const summaryRow = document.createElement("summary");
            summaryRow.className = "health-station-summary";
            const stationLabel = makeElement(
                "span", "", station.station_name + " - " + station.station_id
            );
            const stationState = makeElement(
                "span",
                "health-state health-state-" + status,
                station.status + " - " + station.health_score + "/100"
            );
            summaryRow.append(stationLabel, stationState);
            details.appendChild(summaryRow);

            const scoreTrack = makeElement("div", "health-score-track");
            scoreTrack.setAttribute("role", "img");
            scoreTrack.setAttribute("aria-label", "Health score " + station.health_score + " out of 100");
            const scoreFill = makeElement(
                "div",
                "health-score-fill" + (status === "fault" ? " is-fault" : status === "warning" ? " is-warning" : "")
            );
            scoreFill.style.width = Math.max(0, Math.min(100, Number(station.health_score) || 0)) + "%";
            scoreTrack.appendChild(scoreFill);
            details.appendChild(scoreTrack);

            const hint = makeElement("p", "health-maintenance-hint", station.maintenance_hint);
            details.appendChild(hint);

            (station.parameters || []).forEach(parameter => {
                const row = makeElement("div", "health-parameter-row");
                const heading = makeElement("div", "health-parameter-heading");
                const parameterName = makeElement("strong", "", parameter.label);
                const parameterStatus = makeElement(
                    "span",
                    "health-state health-state-" + String(parameter.status || "Warning").toLowerCase(),
                    parameter.status + " - " + parameter.health_score + "/100"
                );
                heading.append(parameterName, parameterStatus);

                const drift = parameter.drift_slope === null
                    ? "n/a"
                    : formatNumber(parameter.drift_slope, 3) + " " + parameter.drift_unit;
                const metrics = makeElement(
                    "span",
                    "",
                    "Missing " + formatNumber(parameter.missing_data_rate_pct) +
                    "% | Frozen run " + parameter.frozen_value_run_length +
                    " | Anomaly " + formatNumber(parameter.anomaly_rate_pct) +
                    "% | Drift " + drift
                );
                row.append(heading, metrics);
                row.appendChild(makeElement("small", "", parameter.maintenance_hint));
                details.appendChild(row);
            });

            container.appendChild(details);
        });
    }

    function updateDiagnostics(analyses, serviceError = false) {
        const detections = analyses
            .map(item => item.payload && item.payload.detection)
            .filter(Boolean);
        const state = $("diagnosticsState");
        const severityBadge = $("diagnosticSeverity");
        const rootCauseLabel = $("diagnosticRootCause");
        if (state) state.classList.remove("is-loading");

        if (!detections.length) {
            setText("scoreTemporal", "--");
            setText("scoreMultivariate", "--");
            setText("scoreConfidence", "--");
            setText("reasonText", serviceError
                ? "The detection service did not return results for this selection."
                : "No detector results are available for this selection.");
            if (severityBadge) {
                severityBadge.textContent = serviceError ? "Unavailable" : "No result";
                severityBadge.className = "diagnostic-severity sev-unknown";
            }
            if (rootCauseLabel) rootCauseLabel.textContent = serviceError
                ? "Detection service unavailable"
                : "No detector result for the latest observation";
            renderContributors(null);
            if (state) {
                state.textContent = serviceError || analyses.length
                    ? "Detector unavailable"
                    : "No detector results";
                state.classList.toggle("is-error", serviceError || analyses.length > 0);
            }
            return;
        }

        const selectedDetection = detectionForSelectedView() || detections[0];
        const temporal = Number(selectedDetection.temporal_score);
        const multivariate = Number(selectedDetection.multivariate_score);
        const confidence = Number(
            selectedDetection.confidence ??
            (selectedDetection.classification && selectedDetection.classification.confidence)
        );
        setText("scoreTemporal", Number.isFinite(temporal) ? temporal.toFixed(2) : "--");
        setText("scoreMultivariate", Number.isFinite(multivariate) ? multivariate.toFixed(2) : "--");
        setText("scoreConfidence", Number.isFinite(confidence)
            ? formatNumber(confidence * 100) + "%"
            : "--");

        const classification = selectedDetection.classification || {};
        const anomalous = Boolean(selectedDetection.is_anomaly);
        const severity = String(classification.severity || selectedDetection.severity || "unknown").toLowerCase();
        const rootCause = classification.root_cause || selectedDetection.root_cause;
        if (severityBadge) {
            severityBadge.textContent = anomalous
                ? (severity === "unknown" ? "Anomaly" : severity)
                : "No anomaly";
            severityBadge.className = "diagnostic-severity " +
                (anomalous ? "sev-" + severity : "sev-low");
        }
        if (rootCauseLabel) {
            rootCauseLabel.textContent = anomalous
                ? (rootCause ? String(rootCause).replaceAll("_", " ") : "Root cause not reported")
                : "No active anomaly detected in the latest observation";
        }

        const explanations = [
            classification.explanation,
            selectedDetection.plain_english_explanation,
            ...(selectedDetection.reasons || [])
        ].filter(Boolean);
        const uniqueReasons = Array.from(new Set(explanations));
        setText("reasonText", uniqueReasons.length
            ? uniqueReasons.join(" ")
            : anomalous
                ? "The detector flagged an anomaly; no further explanation was returned."
                : "No anomaly was flagged for the latest observation.");
        renderContributors(selectedDetection);
        if (state) {
            const partial = analyses.some(item => !item.payload);
            state.textContent = partial ? "Partial results" : anomalous ? "Anomaly detected" : "Within expected range";
            state.classList.toggle("is-error", partial);
        }
    }

    function severityFor(classification) {
        const classified = classification && classification.severity;
        return classified ? String(classified).toLowerCase() : "unknown";
    }

    function makeElement(tag, className, content) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (content !== undefined) element.textContent = content;
        return element;
    }

    function renderAlert(container, alert) {
        const severity = severityFor(alert.classification);
        const severityClass = severity === "critical" ? "sev-critical"
            : severity === "high" ? "sev-high"
                : severity === "medium" ? "sev-medium"
                    : severity === "low" ? "sev-low" : "sev-unknown";
        const cardClass = severity === "critical" ? "alert-critical"
            : severity === "high" ? "alert-high"
                : severity === "medium" ? "alert-medium"
                    : severity === "low" ? "alert-low" : "alert-unknown";

        const card = makeElement("article", "alert-card " + cardClass);
        const top = makeElement("div", "alert-top");
        const stationLabel = alert.station_id + " (" + stationName(alert.station_id) + ")";
        top.appendChild(makeElement("span", "alert-station", stationLabel));
        top.appendChild(makeElement(
            "span",
            "severity-tag " + severityClass,
            severity === "unknown" ? "SEVERITY UNAVAILABLE" : severity.toUpperCase()
        ));

        const confidence = alert.classification && Number(alert.classification.confidence);
        const confidenceText = Number.isFinite(confidence)
            ? formatNumber(confidence * 100) + "%"
            : "--";
        const typeText = alert.anomalyType || "Anomaly type unavailable";
        const causeText = alert.rootCause
            ? String(alert.rootCause).replaceAll("_", " ")
            : "Not reported";

        card.appendChild(top);
        card.appendChild(makeElement(
            "div",
            "alert-meta",
            "Observed " + formatObservationTime(alert.timestamp) + " | Confidence: " + confidenceText
        ));
        card.appendChild(makeElement(
            "p",
            "alert-cause",
            "Type: " + typeText + " | Root cause: " + causeText
        ));
        card.appendChild(makeElement("p", "alert-explanation", alert.explanation));
        container.appendChild(card);
    }

    function updateAlerts(analyses, serviceError = false) {
        const container = $("alertsList");
        if (!container) return;

        container.replaceChildren();
        if (!weather.length && !serviceError) {
            container.appendChild(makeElement(
                "p", "empty-state", "No observations are available for this selection."
            ));
            return;
        }
        const successful = analyses.filter(item => item.payload && item.payload.detection);
        if (serviceError || !successful.length) {
            container.appendChild(makeElement(
                "p",
                "empty-state is-error",
                serviceError
                    ? "Anomaly results could not be loaded. Check the /detect service connection."
                    : "Anomaly detection is unavailable for the current observations."
            ));
            return;
        }

        const alerts = [];
        successful.forEach(item => {
            const detection = item.payload.detection;
            if (!detection.is_anomaly) return;
            const classification = detection.classification || {};
            const explanation = [
                classification.explanation,
                detection.plain_english_explanation,
                ...(detection.reasons || [])
            ].filter(Boolean);
            alerts.push({
                station_id: item.record.station_id,
                classification,
                timestamp: item.record.timestamp,
                anomalyType: classification.anomaly_type || detection.anomaly_type ||
                    classification.root_cause || detection.root_cause,
                rootCause: classification.root_cause || detection.root_cause,
                explanation: Array.from(new Set(explanation)).join(" ") ||
                    "An anomaly was flagged by /detect for this observation."
            });
        });

        const severityRank = { critical: 4, high: 3, medium: 2, low: 1 };
        alerts.sort((a, b) =>
            (severityRank[severityFor(b.classification)] || 0) -
                (severityRank[severityFor(a.classification)] || 0) ||
            b.timestamp.localeCompare(a.timestamp)
        );

        if (!alerts.length) {
            container.appendChild(makeElement(
                "div",
                "empty-state is-success",
                "No active anomalies"
            ));
            container.appendChild(makeElement(
                "p",
                "empty-state-detail",
                successful.length + " latest station observation(s) analyzed by /detect were not flagged." +
                    (successful.length < analyses.length
                        ? " " + (analyses.length - successful.length) +
                            " station detection(s) could not be loaded."
                        : "")
            ));
            return;
        }

        alerts.forEach(alert => renderAlert(container, alert));
        if (successful.length < analyses.length) {
            container.appendChild(makeElement(
                "p",
                "empty-state-detail is-error",
                (analyses.length - successful.length) + " station detection(s) could not be loaded."
            ));
        }
    }

    function renderContributors(detection) {
        const list = $("diagnosticContributors");
        if (!list) return;
        list.replaceChildren();
        const contributions = detection && Array.isArray(detection.explanation)
            ? detection.explanation
            : [];
        const top = contributions
            .slice()
            .sort((a, b) => {
                const aFired = a.rule_triggered || (a.temporal_reasons || []).length ? 1 : 0;
                const bFired = b.rule_triggered || (b.temporal_reasons || []).length ? 1 : 0;
                return bFired - aFired ||
                    Number(b.contribution_score || 0) - Number(a.contribution_score || 0);
            })
            .slice(0, 3);
        if (!top.length) {
            list.appendChild(makeElement("li", "", "Parameter contributions unavailable."));
            return;
        }
        top.forEach(item => {
            const name = String(item.parameter || "parameter").replaceAll("_", " ");
            const percent = Number(item.contribution_pct);
            const detail = item.rule_detail || (item.temporal_reasons || []).join("; ");
            const contribution = Number.isFinite(percent) ? " | " + formatNumber(percent) + "%" : "";
            list.appendChild(makeElement(
                "li", "", name + contribution + (detail ? " - " + detail : "")
            ));
        });
    }

    function drawChart() {
        const canvas = $("trendChart");
        if (!canvas || !canvas.parentElement) return;

        const records = chartPoints.slice(-24);
        if (!records.length) {
            canvas.style.display = "none";
            setChartState("No analyzed chart readings are available.", "error");
            return;
        }
        canvas.style.display = "block";
        setChartState("", "hidden");

        const context = canvas.getContext("2d");
        if (!context) return;
        const theme = getComputedStyle(document.documentElement);
        const color = (name, fallback) => theme.getPropertyValue(name).trim() || fallback;
        const containerStyle = getComputedStyle(canvas.parentElement);
        const horizontalPadding =
            (parseFloat(containerStyle.paddingLeft) || 0) +
            (parseFloat(containerStyle.paddingRight) || 0);
        const width = Math.max(1, canvas.parentElement.clientWidth - horizontalPadding);
        const height = window.matchMedia("(max-width: 760px)").matches ? 240 : 280;
        const ratio = window.devicePixelRatio || 1;

        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height);

        const left = Math.min(62, Math.max(48, width * 0.15));
        const right = 13;
        const top = 31;
        const bottom = 28;
        const plotWidth = Math.max(1, width - left - right);
        const plotHeight = height - top - bottom;

        let series = [
            { mode: "temp", key: "temperature_c", label: "Temperature", unit: "\u00b0C", color: color("--chart-temp", "#0879ad") },
            { mode: "press", key: "pressure_hpa", label: "Pressure", unit: "hPa", color: color("--chart-pressure", "#6941b7") },
            { mode: "hum", key: "humidity_pct", label: "Humidity", unit: "%", color: color("--chart-humidity", "#117a50") }
        ].filter(item => chartMode === "all" || item.mode === chartMode);

        series = series.map(item => {
            const values = records
                .map(record => record[item.key])
                .filter(value => value !== null && value !== undefined && value !== "")
                .map(Number)
                .filter(Number.isFinite);
            let min = values.length ? Math.min(...values) : 0;
            let max = values.length ? Math.max(...values) : 1;
            if (min === max) {
                const padding = Math.max(Math.abs(min) * 0.05, 1);
                min -= padding;
                max += padding;
            }
            return Object.assign({}, item, { min, max });
        });

        const allMode = chartMode === "all";
        document.querySelectorAll(".legend-item[data-legend]").forEach(item => {
            const mode = item.dataset.legend;
            item.hidden = !allMode && mode !== chartMode && mode !== "anomaly";
        });
        context.fillStyle = color("--chart-label", color("--text-muted", "#52627a"));
        context.font = "600 10px sans-serif";
        context.fillText(
            allMode ? "Relative scale (%)" : series[0].label + " (" + series[0].unit + ")",
            left,
            15
        );

        context.strokeStyle = color("--chart-grid", color("--border-color", "#26334a"));
        context.fillStyle = color("--chart-label", color("--text-muted", "#52627a"));
        context.lineWidth = 1;
        context.font = "10px sans-serif";
        for (let index = 0; index <= 4; index++) {
            const fraction = index / 4;
            const y = top + plotHeight * fraction;
            context.beginPath();
            context.moveTo(left, y);
            context.lineTo(width - right, y);
            context.stroke();

            let label = (100 - fraction * 100).toFixed(0) + "%";
            if (!allMode && series.length) {
                const item = series[0];
                const value = item.max - (item.max - item.min) * fraction;
                label = value.toFixed(item.mode === "press" ? 1 : 1).replace(/\\.0$/, "");
            }
            context.fillText(label, 3, y + 3);
        }

        series.forEach(item => {
            context.beginPath();
            context.strokeStyle = item.color;
            context.lineWidth = 2.2;
            context.lineJoin = "round";
            context.lineCap = "round";
            let started = false;

            records.forEach((record, index) => {
                const rawValue = record[item.key];
                const value = Number(rawValue);
                if (rawValue === null || rawValue === undefined || rawValue === "" ||
                    !Number.isFinite(value)) {
                    started = false;
                    return;
                }
                const normalized = Math.max(0, Math.min(1, (value - item.min) / (item.max - item.min)));
                const x = left + index / Math.max(1, records.length - 1) * plotWidth;
                const y = top + (1 - normalized) * plotHeight;
                if (!started) {
                    context.moveTo(x, y);
                    started = true;
                } else {
                    context.lineTo(x, y);
                }
            });
            context.stroke();
        });

        records.forEach((record, index) => {
            if (!record.detection || !record.detection.is_anomaly) return;
            const x = left + index / Math.max(1, records.length - 1) * plotWidth;
            context.save();
            context.strokeStyle = color("--chart-anomaly", "#b82c3b");
            context.fillStyle = color("--chart-anomaly", "#b82c3b");
            context.setLineDash([3, 4]);
            context.beginPath();
            context.moveTo(x, top);
            context.lineTo(x, top + plotHeight);
            context.stroke();
            context.setLineDash([]);
            context.beginPath();
            context.arc(x, top, 4, 0, Math.PI * 2);
            context.fill();
            context.restore();
        });

        context.fillStyle = color("--chart-label", color("--text-muted", "#52627a"));
        context.font = "10px sans-serif";
        context.fillText("24 h ago", left, height - 6);
        context.fillText("Latest", Math.max(left, width - right - 30), height - 6);

        setText(
            "chartScaleNote",
            allMode
                ? "Each parameter is independently scaled across the loaded observations."
                : "Axis is fitted to the loaded " + series[0].label.toLowerCase() + " observations in " + series[0].unit + "."
        );
    }

    function applyTheme() {
        const root = document.documentElement;
        root.dataset.theme = darkMode ? "dark" : "light";
        const button = $("themeToggle");
        if (button) {
            button.title = darkMode ? "Switch to light theme" : "Switch to dark theme";
            button.setAttribute("aria-label", darkMode ? "Dark theme" : "Light theme");
            button.setAttribute("aria-pressed", String(darkMode));
        }
    }

    function createThemeButton() {
        let savedTheme = null;
        try {
            savedTheme = localStorage.getItem("skyguard-theme");
        } catch (_) {
            // Theme switching still works if storage is unavailable.
        }
        darkMode = savedTheme !== "light";

        const button = $("themeToggle");
        if (button) {
            button.addEventListener("click", () => {
                darkMode = !darkMode;
                try {
                    localStorage.setItem("skyguard-theme", darkMode ? "dark" : "light");
                } catch (_) {
                    // Keep the selected theme for this page session.
                }
                applyTheme();
                drawChart();
            });
        }
        applyTheme();
    }

    function setupEvents() {
        const select = $("stationSelect");
        if (select) {
            select.addEventListener("change", () => {
                selectedStation = select.value || "ALL";
                loadWeather();
            });
        }

        document.querySelectorAll("[data-chart]").forEach(button => {
            button.addEventListener("click", () => {
                chartMode = button.dataset.chart || "all";
                document.querySelectorAll("[data-chart]").forEach(item => {
                    const active = item === button;
                    item.classList.toggle("active", active);
                    item.setAttribute("aria-pressed", String(active));
                });
                drawChart();
            });
        });

        const destinations = {
            overview: $("overview"),
            stations: $("stations"),
            alerts: $("alerts"),
            analytics: $("analytics")
        };
        document.querySelectorAll("[data-tab]").forEach(button => {
            button.addEventListener("click", () => {
                const target = destinations[button.dataset.tab];
                if (target) target.scrollIntoView({
                    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                        ? "auto"
                        : "smooth",
                    block: "start"
                });
                document.querySelectorAll("[data-tab]").forEach(item => {
                    const active = item === button;
                    item.classList.toggle("active", active);
                    if (active) item.setAttribute("aria-current", "location");
                    else item.removeAttribute("aria-current");
                });
            });
        });
    }

    function updateClock() {
        const now = new Date();
        const display = new Intl.DateTimeFormat("en-IN", {
            timeZone: "Asia/Kolkata",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
        }).format(now);
        setText("currentTime", display + " IST");
    }

    async function refreshDashboard() {
        if (!stations.length) {
            try {
                await loadStations();
            } catch (error) {
                console.error("Station list refresh failed:", error);
                setDashboardState("Station list unavailable: " + error.message, "error");
                showHealthError(error);
                setChartState("Station data unavailable.", "error");
                updateDiagnostics([], true);
                updateAlerts([], true);
                setText(
                    "reasonText",
                    "Backend connection unavailable. Start the SkyGuard AI FastAPI server and the dashboard will retry automatically."
                );
                return;
            }
        }
        await loadWeather();
    }

    async function start() {
        createThemeButton();
        setupEvents();
        updateClock();
        window.setInterval(updateClock, 1000);

        await refreshDashboard();
        window.setInterval(refreshDashboard, REFRESH_TIME);
        window.addEventListener("resize", drawChart);
    }

    document.addEventListener("DOMContentLoaded", start);
})();
