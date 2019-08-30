
class VoIPTesterError extends Error {
    constructor(errcode, message, cause) {
        super(message);
        this.errcode = errcode;
        this.cause = cause;

        // https://stackoverflow.com/a/500531
        this.name = this.constructor.name;
        if (typeof Error.captureStackTrace === 'function') {
          Error.captureStackTrace(this, this.constructor);
        } else {
          this.stack = (new Error(message)).stack;
        }
    }

    toString() {
        return super.toString() + " [" + this.errcode + "]";
    }
}

let VoIPTesterErrors = {
    BAD_ACCESS_TOKEN: "Bad access token",
    FAILED_HOMESERVER_CONNECTION: "Failed homeserver connection",
    BAD_LOGIN_CREDENTIALS: "Bad credentials",
    LOGIN_FAILURE: "Login method not supported. Supply an access token manually instead.",
    BAD_TURN_CREDENTIALS: "Bad TURN credentials",
    CANNOT_GET_TURN_CREDENTIALS: "Can't get TURN credentials from homeserver",
    NO_TURN_SERVERS: "No TURN servers",
    UNKNOWN: "Unknown",

    FAILED_SERVICE_REQUEST: "Failed testing service request",
    FAILED_DOCTOR_SDP: "Failed to doctor the SDP",
};

const MAGIC_QUESTION = "Hello? Is this on?";
const MAGIC_ANSWER = "Yes; yes, it is! :^)";

function getIpVersion(ipAddress) {
    return /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(ipAddress)
        ? 'IPv4' : 'IPv6';
}

class VoIPTester {
    constructor(homeserverUrl, remoteTestServiceUrl) {
        this.homeserver = homeserverUrl;
        this.remoteTestServiceUrl = remoteTestServiceUrl;
        this.accessToken = null;
    }

    _fetchClient(path, method, body) {
        let extra = {
            headers: {
              'Authorization': 'Bearer ' + this.accessToken,
            },
            method: method,
        };

        if (method == 'PUT' || method == 'POST') {
            extra.headers['Content-Type'] = 'application/json';
            extra.body = JSON.stringify(body);
        }

        return fetch(this.homeserver + "/_matrix/client/r0" + path, extra);
    }

    loginWithUserIdAndPassword(userId, password) {
        return this
            ._fetchClient("/login", "POST", {
                type: "m.login.password",
                identifier: {
                    type: "m.id.user",
                    user: userId,
                },
                password: password,
                initial_device_display_name: "VoIP Tester",
            })
            .then((resp) => {
                if (resp.status == 200) {
                    return resp.json().then((json) => {
                        this.accessToken = json.access_token;
                    });
                } else if (resp.status == 403) {
                    throw new VoIPTesterError(
                        VoIPTesterErrors.BAD_CREDENTIALS,
                        resp.json().error || "403 on /login"
                    );
                } else if (resp.status == 400) {
                    throw new VoIPTesterError(
                        VoIPTesterErrors.LOGIN_FAILURE,
                        resp.json().error || "400 on /login"
                    );
                } else {
                    return resp.json().then(json => {
                        let errStr = json.errcode + " " + json.error + " " + resp.status;
                        throw new VoIPTesterError(
                            VoIPTesterErrors.UNKNOWN,
                            errStr
                        );
                    });
                }
            });
    }

    loginWithAccessToken(accessToken) {
        this.accessToken = accessToken;
        return this._fetchClient("/account/whoami", "GET")
            .then((response) => {
                console.log("then", response);
            })
            .catch((error) => {
                throw new VoIPTesterError(
                    VoIPTesterErrors.FAILED_HOMESERVER_CONNECTION,
                    "Failed to connect for /account/whoami",
                    error
                );
            });
    }

    gatherTurnConfig() {
        return this
            ._fetchClient("/voip/turnServer", "GET")
            .then((resp) => {
                if (resp.status != 200) {
                    return resp.json().then(json => {
                        let errStr = json.errcode + " " + json.error + " " + resp.status;

                        throw new VoIPTesterError(
                            VoIPTesterErrors.CANNOT_GET_TURN_CREDENTIALS,
                            errStr
                        );
                    });
                }
                return resp.json().then(json => {
                    if (json.uris.length < 1) {
                        throw new VoIPTesterError(
                            VoIPTesterErrors.NO_TURN_SERVERS,
                            "Empty `uris` list from /voip/turnServer"
                        );
                    }
                    return json;
                });
            });
    }

    gatherCandidatesForIceServer(turnUri, turnUsername, turnPassword) {
        // filter out host results

        let candidates = [];

        let conn = new RTCPeerConnection({
            iceServers: [
                {
                    urls: turnUri,
                    username: turnUsername,
                    credential: turnPassword
                }
            ]
        });

        let datchan = conn.createDataChannel("voiptest");

        // TODO
        window.conn = conn;
        window.datchan = datchan;
        window.candidates = candidates;

        return new Promise(resolve => {
            conn.onicecandidate = function (evt) {
                console.log("ICE Candidate", evt);

                if (evt.candidate === null) {
                    // this is the end-of-candidates marker
                    console.log("ld", conn.localDescription);
                    resolve({
                        peerConnection: conn,
                        dataChannel: datchan,
                        candidates: candidates,
                    });
                } else {
                    candidates.push(evt.candidate);
                }

                evt.preventDefault();
            };

            console.log("waiting for negotiationneeded");
            conn.addEventListener("negotiationneeded", ev => {
                console.log("creating offer");
                conn.createOffer().then(offer => {
                    console.log("offer", offer);
                    conn.setLocalDescription(offer)
                });
            });
        });
    }

    /**
     * Doctors (modifies) some SDP to remove candidates that wouldn't
     * exercise the candidate we want to test.
     *
     * Beware that this probably won't behave for more than one media track.
     */
    doctorOfferSdp(offerSdp, soleWantedCandidate) {
        let sdpLines = offerSdp.split(/\r?\n/g);

        let foundPreservedCandidate = false;

        // .candidate gives the candidate SDP for it.
        let checkingFor = "a=" + soleWantedCandidate.candidate;

        for (let i = sdpLines.length - 1; i >= 0; --i) {
            if (sdpLines[i].startsWith("a=candidate:")) {
                // this is a candidate line
                if (sdpLines[i] == checkingFor) {
                    foundPreservedCandidate = true;
                } else {
                    // remove index i – not a wanted candidate
                    sdpLines.splice(i, 1);
                }
            }
        }

        if (! foundPreservedCandidate) {
            throw new VoIPTesterError(
                VoIPTesterErrorCodes.FAILED_DOCTOR_SDP,
                "Failed to find wanted candidate in offer SDP."
            );
        }

        return sdpLines.join("\r\n");
    }

    testTurnRelaying(ipVersion, candidateResult) {
        // select a relay candidate of the appropriate IP version
        let candidate = null;
        for (let i = 0; i < candidateResult.candidates.length; ++i) {
            let potentialCandidate = candidateResult.candidates[i];
            if (potentialCandidate.type == 'relay' &&
                getIpVersion(potentialCandidate.ip) == ipVersion) {
                candidate = potentialCandidate;
                break;
            }
        }

        if (candidate === null) {
            return null; // TODO how to handle lack of candidate? Need to define response format.
        }

        let connection = candidateResult.peerConnection;
        let dataChannel = candidateResult.dataChannel;

        let doctoredSdp = this.doctorOfferSdp(connection.localDescription.sdp, candidate);

        console.log("about to set doctored");
        connection.setLocalDescription({
            sdp: doctoredSdp, type: 'offer'
        })
            .then(() => {
                console.log("just set doctored");
                return fetch(this.remoteTestServiceUrl, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        offer: connection.localDescription,
                        // candidate.candidate gives the SDP a= description of the
                        // candidate.
                        candidate: candidate.candidate
                    })
                })
            })
            .then(resp => {
                if (resp.status != 200) {
                    throw new VoIPTesterError(
                        VoIPTesterErrors.FAILED_SERVICE_REQUEST,
                        resp.status + " when contacting testing service"
                    );
                }
                return resp;
            })
            .then(resp => resp.json())
            .then(serviceResponse => {
                console.log("ANSWER", serviceResponse.answer);
                connection.setRemoteDescription(serviceResponse.answer);
            });



        // TODO wait for things to happen … or time out with failure (does this happen automatically?)

        // TODO
    }

    /**
     * Runs the test against either IPv4 or IPv6 (specify 'IPv4' or 'IPv6').
     *
     * Note that the IP version refers to that of the candidates – not that
     * of the STUN/TURN protocol itself (as we cannot control that really).
     */
    runIpVersionedTest(ipVersion, testReport, turnConfig) {
        let numUris = turnConfig.uris.length;
        let numTested = 0;
        let candidateResults = [];

        let builtPromise = Promise.resolve();

        let testPassReport = testReport.passes[ipVersion];

        for (let i = 0; i < numUris; ++i) {
            let turnUri = turnConfig.uris[i];
            testPassReport[turnUri] = {};

            builtPromise = builtPromise
                .then(() => {
                    this.onProgress(2, i, numUris, "TURN URI: " + turnUri);
                    this.onProgress(3, 0, 2, "Gathering candidates");

                    return this.gatherCandidatesForIceServer(turnUri, turnConfig.username, turnConfig.password);
                })
                .then((candidateResult) => {
                    testPassReport[turnUri].candidates = this.summariseCandidateGathering(candidateResult);

                    this.onProgress(3, 1, 2, "Testing TURN relaying");

                    return this.testTurnRelaying(ipVersion, candidateResult);
                })
                .then((turnRelayResult) => {
                    testPassReport[turnUri].turnRelayResult = turnRelayResult;

                    testPassReport[turnUri].report = this.summariseTurnUriReport(ipVersion, testPassReport[turnUri]);
                });
        }

        return builtPromise;
    }

    runTest() {
        this.onProgress(1, 0, 3, "Requesting TURN details from homeserver");

        let testReport = {
            passes: {
                'IPv4': {},
                'IPv6': {}
            }
        };

        return this
            .gatherTurnConfig()
            .then((turnConfig) => {
                this.onProgress(1, 1, 3, "Testing (IPv4 candidates)");

                testReport.turnConfig = turnConfig;

                return this.runIpVersionedTest('IPv4', testReport, testReport.turnConfig);
            })
            .then(() => {
                this.onProgress(1, 2, 3, "Testing (IPv6 candidates)");

                return this.runIpVersionedTest('IPv6', testReport, testReport.turnConfig);
            })
            .then(() => {
                // TODO finalise & return report in some way.
            });
    }


    summariseCandidateGathering(candidateResult) {
        return {
            "blergh": "PASS maybe" // TODO what do we do here. Just copy telling fields from the IceCandidates
        };
    }

    summariseTurnUriReport(ipVersion, turnUriReport) {
        return {
            "blergh": "PASS maybe" // TODO what do we do here
        };

        // report architecture: want a:
        // - success? Or else any information we know
        // - time ?
        // - feature flags (e.g. TURNS; TURNS over 443)
        // -
    }


    // The following methods are intended to be overridden

    /**
     * Called when we have information about progress.
     * Progress levels can be thought of as a tree / hierarchy.
     * Progress at level `i` must be completed to make progress in level `i - 1`.
     * level will never be more than 1 greater than the previously-called level.
     *
     * Args:
     * - level (int): The depth of the hierarchy; starting at 1 for the root task.
     * - currentValue (int): Amount of completed progress at this level.
     * - maxValue (int): Maximum amount of doable progress at this level.
     * - statusLine (String): Terse human-readable summary of progress at this level.
     */
    onProgress(level, currentValue, maxValue, statusLine) {
        let prefix = "• ".repeat(level);
        console.log(prefix + "[" + currentValue + "/" + maxValue + "] " + statusLine);
    }
}
