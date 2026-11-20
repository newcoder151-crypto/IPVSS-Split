/* CMS console - fleet, map, segments, registry, users, settings, audit */
(function () {
  "use strict";
  const C = window.C;
  const {
    h,
    S,
    api,
    badge,
    stBadge,
    fmtTime,
    fmtShort,
    ago,
    fmtSize,
    fmtDur,
    label,
    table,
    head,
    section,
    kv,
    actionBtn,
    qs,
    chips,
    pager,
    toast,
  } = C;
  const V = C.views;
  const NS = "http://www.w3.org/2000/svg";
  const sv = (tag, attrs, ...kids) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    kids.forEach((k2) =>
      e.append(typeof k2 === "string" ? document.createTextNode(k2) : k2),
    );
    return e;
  };

  // =========================================================================================
  // Live map: SVG geo plot (no external tiles - works on a closed network)
  // =========================================================================================
  function geoPlot(m, { width = 900, height = 480, track } = {}) {
    const pts = [...m.posts, ...m.nvrs, ...m.alerts, ...(track || [])].filter(
      (p) => p.lat != null,
    );
    if (!pts.length)
      return h(
        "div",
        { class: "card empty" },
        "No positions yet. Units appear here as soon as they report in.",
      );
    let minLat = Math.min(...pts.map((p) => p.lat));
    let maxLat = Math.max(...pts.map((p) => p.lat));
    let minLon = Math.min(...pts.map((p) => p.lon));
    let maxLon = Math.max(...pts.map((p) => p.lon));
    const padLat = Math.max(0.02, (maxLat - minLat) * 0.12);
    const padLon = Math.max(0.02, (maxLon - minLon) * 0.12);
    minLat -= padLat;
    maxLat += padLat;
    minLon -= padLon;
    maxLon += padLon;
    const midLat = (minLat + maxLat) / 2;
    const kx = Math.cos((midLat * Math.PI) / 180);
    // equirectangular, aspect-correct, fitted into the box
    const spanX = (maxLon - minLon) * kx;
    const spanY = maxLat - minLat;
    const scale = Math.min(width / spanX, height / spanY);
    const ox = (width - spanX * scale) / 2;
    const oy = (height - spanY * scale) / 2;
    const X = (lon) => ox + (lon - minLon) * kx * scale;
    const Y = (lat) => oy + (maxLat - lat) * scale;
    const svg = sv("svg", { viewBox: `0 0 ${width} ${height}`, class: "geo" });
    svg.append(
      sv("rect", { x: 0, y: 0, width, height, fill: "var(--map-bg)" }),
    );
    for (let i = 1; i < 6; i++) {
      svg.append(
        sv("line", {
          x1: (width / 6) * i,
          y1: 0,
          x2: (width / 6) * i,
          y2: height,
          stroke: "var(--map-grid)",
        }),
      );
      svg.append(
        sv("line", {
          x1: 0,
          y1: (height / 6) * i,
          x2: width,
          y2: (height / 6) * i,
          stroke: "var(--map-grid)",
        }),
      );
    }
    if (track && track.length > 1)
      svg.append(
        sv("polyline", {
          points: track.map((p) => `${X(p.lon)},${Y(p.lat)}`).join(" "),
          fill: "none",
          stroke: "#1d5a9a",
          "stroke-width": 2,
          "stroke-dasharray": "4 3",
        }),
      );
    for (const a of m.alerts) {
      const hi = a.priority >= m.threshold;
      const c = sv("circle", {
        cx: X(a.lon),
        cy: Y(a.lat),
        r: hi ? 7 : 5,
        fill: hi ? "#c62828" : "#ef9a1c",
        "fill-opacity": 0.75,
        stroke: "#fff",
        class: "pt",
      });
      c.append(
        sv(
          "title",
          {},
          `${label(a.alert_type)} P${a.priority} - ${a.status} - ${fmtTime(a.event_time)} (${a.nvr_name})`,
        ),
      );
      c.addEventListener("click", () => C.openAlert(a.id));
      svg.append(c);
    }
    for (const p of m.posts) {
      const r = sv("rect", {
        x: X(p.lon) - 6,
        y: Y(p.lat) - 6,
        width: 12,
        height: 12,
        fill: p.active ? "#12355b" : "#90a4ae",
        stroke: "#fff",
      });
      r.append(sv("title", {}, `Post: ${p.name} (${p.zone_name})`));
      svg.append(r);
      svg.append(
        sv(
          "text",
          {
            x: X(p.lon) + 9,
            y: Y(p.lat) + 4,
            "font-size": 11,
            fill: "var(--ink)",
          },
          p.name,
        ),
      );
    }
    for (const n of m.nvrs) {
      const t = sv("polygon", {
        points: `${X(n.lon)},${Y(n.lat) - 9} ${X(n.lon) - 8},${Y(n.lat) + 6} ${X(n.lon) + 8},${Y(n.lat) + 6}`,
        fill: n.online ? "#2e7d32" : "#78909c",
        stroke: "#fff",
      });
      t.append(
        sv(
          "title",
          {},
          `${n.name}${n.train_no ? ` - ${n.train_no}` : ""} - ${n.online ? "online" : "offline"} - seen ${ago(n.last_seen)}`,
        ),
      );
      svg.append(t);
      svg.append(
        sv(
          "text",
          {
            x: X(n.lon) + 10,
            y: Y(n.lat) - 2,
            "font-size": 11,
            fill: n.online ? "#2e7d32" : "#78909c",
            "font-weight": 600,
          },
          n.name,
        ),
      );
    }
    return h(
      "div",
      { class: "card" },
      svg,
      h(
        "div",
        { class: "legend pad" },
        h("i", { style: "background:#12355b" }),
        "RPF post ",
        h("i", { style: "background:#2e7d32" }),
        "train (online) ",
        h("i", { style: "background:#78909c" }),
        "train (offline) ",
        h("i", { style: "background:#c62828" }),
        "high-priority alert ",
        h("i", { style: "background:#ef9a1c" }),
        "alert, last 24 h",
      ),
    );
  }
  V.map = async () => {
    const m = await api("/map" + qs({ zone_id: S.params.zone_id }));
    return h(
      "div",
      {},
      head(
        "Live map",
        C.zoneSelect(),
        h(
          "span",
          { class: "muted" },
          "positions refresh every few seconds - click an alert dot to open it",
        ),
      ),
      geoPlot(m),
    );
  };

  // =========================================================================================
  // Fleet
  // =========================================================================================
  V.fleet = async () => {
    const rows = await api("/nvrs" + qs({ zone_id: S.params.zone_id }));
    const removedBox = h("div", {});
    if (C.isAdmin()) showRemoved(removedBox);
    return h(
      "div",
      {},
      head(
        "Fleet (M-NVR units)",
        C.zoneSelect(),
        C.isAdmin()
          ? h(
              "button",
              { class: "btn primary", onclick: nvrDialog },
              "Register NVR",
            )
          : null,
      ),
      C.groupedBy(
        "fleet",
        rows,
        {
          key: (n) =>
            n.train_no && n.train_no.trim() ? n.train_no.trim() : "",
          sort: (a, b) =>
            a === ""
              ? 1
              : b === ""
                ? -1
                : String(a).localeCompare(String(b), undefined, {
                    numeric: true,
                  }),
          title: (k) => (k ? `Train ${k}` : "No train number"),
          summary: (l) =>
            `${l.length} M-NVR${l.length === 1 ? "" : "s"} - ${l.filter((n) => n.online).length} online - ${l.reduce((a, n) => a + Number(n.cameras || 0), 0)} cameras`,
        },
        (list) =>
          table(
            [
              "Unit",
              "M-NVR no.",
              "Zone",
              "Status",
              "Last contact",
              "Cameras",
              "Pending",
              "Alerts 24h",
              "Health",
              "",
            ],
            list
              .slice()
              .sort(
                (a, b) => Number(a.unit_no || a.id) - Number(b.unit_no || b.id),
              )
              .map((n) =>
                h(
                  "tr",
                  { class: "click", onclick: () => openNvr(n.id) },
                  h(
                    "td",
                    {},
                    h("b", {}, n.name),
                    n.health && n.health.ip
                      ? h("div", { class: "muted" }, n.health.ip)
                      : null,
                  ),
                  h(
                    "td",
                    {},
                    n.train_no
                      ? `M${String(n.unit_no || n.id).padStart(2, "0")}`
                      : "-",
                  ),
                  h("td", {}, n.zone_name),
                  h(
                    "td",
                    {},
                    n.status !== "active"
                      ? badge(n.status, "red")
                      : n.online
                        ? badge("online", "green")
                        : badge("offline", "grey"),
                  ),
                  h(
                    "td",
                    {},
                    ago(n.last_seen),
                    n.lat != null
                      ? h(
                          "div",
                          { class: "muted" },
                          `${n.lat.toFixed(3)}, ${n.lon.toFixed(3)}`,
                        )
                      : null,
                  ),
                  h("td", {}, n.cameras),
                  h(
                    "td",
                    {},
                    +n.waiting_requests
                      ? badge(
                          `${n.waiting_requests} request(s) waiting`,
                          "teal",
                        )
                      : "",
                    +n.open_commands
                      ? h(
                          "div",
                          { class: "muted" },
                          `${n.open_commands} command(s)`,
                        )
                      : null,
                    +n.uploading
                      ? h("div", { class: "muted" }, `${n.uploading} uploading`)
                      : null,
                  ),
                  h("td", {}, n.alerts_24h),
                  h(
                    "td",
                    {},
                    n.health
                      ? h(
                          "span",
                          { class: "muted" },
                          `disk ${n.health.disk_used_pct ?? "?"}%, ${n.health.cameras_ok ?? "?"} cam ok`,
                        )
                      : "-",
                  ),
                  h(
                    "td",
                    {},
                    C.isAdmin()
                      ? h(
                          "button",
                          {
                            class: "btn danger sm",
                            title: "Remove this M-NVR from the fleet",
                            onclick: (ev) => {
                              ev.stopPropagation();
                              deleteNvr(n);
                            },
                          },
                          "Delete",
                        )
                      : null,
                  ),
                ),
              ),
            "No units registered.",
          ),
      ),
      removedBox,
    );
  };
  async function showRemoved(box) {
    let list = [];
    try {
      list = await api("/nvrs-removed");
    } catch (_) {
      /* not an admin */
    }
    box.replaceChildren();
    if (!list.length) return;
    box.append(
      h(
        "div",
        { class: "card" },
        h("h3", {}, `Removed M-NVRs (${list.length})`),
        h(
          "div",
          { class: "muted" },
          "Deleted by mistake? Restore brings the unit back with its train, cameras and footage. A removed unit that is still running comes back by itself.",
        ),
        h(
          "table",
          { class: "tbl" },
          h(
            "tbody",
            {},
            ...list.map((r) =>
              h(
                "tr",
                {},
                h(
                  "td",
                  {},
                  h("b", {}, r.name),
                  r.ip ? h("div", { class: "muted" }, r.ip) : null,
                ),
                h("td", {}, r.train_no ? `Train ${r.train_no}` : "no train"),
                h("td", {}, `${r.cameras} cameras`),
                h(
                  "td",
                  {},
                  h(
                    "button",
                    {
                      class: "btn sm",
                      onclick: async () => {
                        await api("/nvrs/" + r.id + "/restore", {
                          method: "POST",
                          body: {},
                        });
                        C.toast(`${r.name} restored`);
                        C.refresh();
                      },
                    },
                    "Restore",
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
  function deleteNvr(n) {
    C.confirm(
      `Delete ${n.name}?`,
      `${n.name} is removed from the fleet. Its footage, alerts and incidents stay in the CMS and its open upload commands are cancelled.${n.online ? " It is online right now: unless that is switched off in the CMS settings, it reconnects by itself within seconds and returns to the fleet (so a delete by mistake undoes itself). To get rid of a unit for good, switch its M-NVR bridge off first." : ""}`,
      "Delete M-NVR",
      async () => {
        const r = await api("/nvrs/" + n.id, { method: "DELETE" });
        C.toast(
          r.deleted
            ? `${n.name} deleted`
            : r.comes_back
              ? `${n.name} removed - it returns by itself if its bridge is still running`
              : `${n.name} removed from the fleet (its footage is kept)`,
        );
        C.refresh();
      },
      true,
    );
  }
  function nvrDialog() {
    // Only what CMS cannot learn by itself. The unit proves who it is when its bridge connects, and its cameras come from the M-NVR.
    C.formDialog({
      title: "Register M-NVR",
      sub: "Registering is optional: an M-NVR whose bridge points at this CMS appears in the fleet by itself the first time it connects, and its IP address is learned automatically. Register it here only to prepare its name / train / zone - use the name exactly as in the M-NVR (its device name) and it claims this entry when it connects.",
      submitLabel: "Register",
      fields: [
        { name: "name", label: "Unit name (same as the M-NVR's device name)" },
        {
          name: "train_no",
          label:
            "Train number (optional - the M-NVR's own setting is used if left empty)",
        },
        ...(C.isSuper()
          ? [
              {
                name: "zone_id",
                label: "Zone",
                type: "select",
                value: S.zones[0] && S.zones[0].id,
                options: S.zones.map((z) => ({ value: z.id, label: z.name })),
              },
            ]
          : []),
      ],
      submit: async (v) => {
        await api("/nvrs", {
          method: "POST",
          body: { ...v, zone_id: v.zone_id ? Number(v.zone_id) : undefined },
        });
        C.toast(
          "Registered - it connects by itself and shows online as soon as its M-NVR bridge starts",
        );
        C.refresh();
      },
    });
  }
  function openNvr(id) {
    C.openDrawer(`nvr-${id}`, async () => {
      const d = await api(`/nvrs/${id}`);
      const n = d.nvr;
      const online =
        n.last_seen && Date.now() - new Date(n.last_seen).getTime() < 90000;
      const cmd = (kind, extra) =>
        actionBtn(
          label(kind),
          async () => {
            await api(`/nvrs/${id}/command`, {
              method: "POST",
              body: { kind, ...extra },
            });
            toast("Command queued - delivered when the unit next contacts CMS");
            C.reloadDrawer();
          },
          "sm",
        );
      return C.drawerShell(
        `${n.name}${n.train_no ? ` - ${n.train_no}` : ""}`,
        section(
          "Unit",
          kv([
            [
              "Status",
              n.status !== "active"
                ? badge(n.status, "red")
                : online
                  ? badge("online", "green")
                  : badge("offline", "grey"),
            ],
            ["Last contact", `${fmtTime(n.last_seen)} (${ago(n.last_seen)})`],
            ["Zone", n.zone_name],
            ["Position", C.mapLink(n.last_lat, n.last_lon)],
            [
              "Speed",
              n.last_speed_mps != null
                ? `${Math.round(n.last_speed_mps * 3.6)} km/h`
                : "-",
            ],
            n.health
              ? [
                  "Health",
                  Object.entries(n.health).map(([k, v]) =>
                    h("div", {}, `${label(k)}: ${v}`),
                  ),
                ]
              : null,
          ]),
          h(
            "div",
            { class: "actions mt" },
            cmd("ping"),
            cmd("sync_clock"),
            C.isAdmin()
              ? h(
                  "button",
                  {
                    class: "btn sm",
                    onclick: () =>
                      C.formDialog({
                        title: `Edit ${n.name}`,
                        fields: [
                          { name: "name", label: "Name", value: n.name },
                          {
                            name: "train_no",
                            label: "Train number",
                            value: n.train_no || "",
                          },
                          {
                            name: "status",
                            label: "Status",
                            type: "select",
                            value: n.status,
                            options: ["active", "inactive", "suspended"].map(
                              (s) => ({ value: s, label: s }),
                            ),
                          },
                        ],
                        submit: async (v) => {
                          await api(`/nvrs/${id}`, {
                            method: "PATCH",
                            body: v,
                          });
                          C.reloadDrawer();
                          C.refresh();
                        },
                      }),
                  },
                  "Edit",
                )
              : null,
            C.isSuper()
              ? h(
                  "button",
                  {
                    class: "btn sm",
                    onclick: () =>
                      C.formDialog({
                        title: "Move to another zone",
                        sub: "Closes the current assignment and opens a new one; footage stays attributable to the zone that owned the unit at the time.",
                        fields: [
                          {
                            name: "zone_id",
                            label: "New zone",
                            type: "select",
                            options: S.zones
                              .filter((z) => z.id !== n.current_zone_id)
                              .map((z) => ({ value: z.id, label: z.name })),
                          },
                        ],
                        submit: async (v) => {
                          await api(`/nvrs/${id}/assign-zone`, {
                            method: "POST",
                            body: { zone_id: Number(v.zone_id) },
                          });
                          C.reloadDrawer();
                          C.refresh();
                        },
                      }),
                  },
                  "Change zone",
                )
              : null,
          ),
        ),
        d.track.length > 1
          ? section(
              "Last 6 hours",
              geoPlot(
                {
                  posts: [],
                  nvrs: [{ ...n, lat: n.last_lat, lon: n.last_lon, online }],
                  alerts: [],
                  threshold: 7,
                },
                { width: 560, height: 220, track: d.track },
              ),
            )
          : null,
        section(
          `Cameras (${d.cameras.length})`,
          d.cameras.map((c) =>
            h(
              "div",
              { class: "item" },
              h("b", {}, c.name),
              c.active ? "" : badge("inactive", "grey"),
              h(
                "div",
                { class: "muted" },
                `${c.mount_position || "position not set"} - ${c.segments} segments stored, last ${ago(c.last_segment)}`,
              ),
              C.isAdmin()
                ? h(
                    "div",
                    { class: "actions" },
                    h(
                      "button",
                      {
                        class: "btn sm",
                        onclick: () =>
                          C.formDialog({
                            title: `Edit ${c.name}`,
                            fields: [
                              { name: "name", label: "Name", value: c.name },
                              {
                                name: "mount_position",
                                label: "Mount position",
                                value: c.mount_position || "",
                              },
                              {
                                name: "active",
                                label: "Active",
                                type: "checkbox",
                                value: c.active,
                              },
                            ],
                            submit: async (v) => {
                              await api(`/cameras/${c.id}`, {
                                method: "PATCH",
                                body: v,
                              });
                              C.reloadDrawer();
                            },
                          }),
                      },
                      "Edit",
                    ),
                    h(
                      "button",
                      {
                        class: "btn sm",
                        onclick: () =>
                          C.formDialog({
                            title: `Pull footage from ${c.name} now`,
                            sub: "Tells the unit to upload this window to the CMS (without a post request).",
                            submitLabel: "Send command",
                            fields: [
                              {
                                name: "ws",
                                label: "From",
                                type: "datetime-local",
                                value: C.toLocalInput(
                                  new Date(Date.now() - 15 * 60000),
                                ),
                              },
                              {
                                name: "we",
                                label: "To",
                                type: "datetime-local",
                                value: C.toLocalInput(
                                  new Date(Date.now() - 60000),
                                ),
                              },
                            ],
                            submit: async (v) => {
                              await api(`/nvrs/${id}/command`, {
                                method: "POST",
                                body: {
                                  kind: "upload_now",
                                  camera_id: c.id,
                                  window_start: new Date(v.ws).toISOString(),
                                  window_end: new Date(v.we).toISOString(),
                                },
                              });
                              C.reloadDrawer();
                            },
                          }),
                      },
                      "Pull footage...",
                    ),
                  )
                : null,
            ),
          ),
          C.isAdmin()
            ? h(
                "button",
                {
                  class: "btn sm mt",
                  onclick: () =>
                    C.formDialog({
                      title: "Add camera",
                      fields: [
                        { name: "name", label: "Name" },
                        { name: "mount_position", label: "Mount position" },
                      ],
                      submit: async (v) => {
                        await api(`/nvrs/${id}/cameras`, {
                          method: "POST",
                          body: v,
                        });
                        C.reloadDrawer();
                      },
                    }),
                },
                "Add camera",
              )
            : null,
        ),
        section(
          "Recent commands",
          d.commands.length
            ? d.commands.map((c) =>
                h(
                  "div",
                  { class: "item" },
                  `#${c.id} ${label(c.kind)} `,
                  stBadge("cmd", c.status),
                  h(
                    "div",
                    { class: "muted" },
                    `${fmtTime(c.created_at)}${c.request_id ? ` - request #${c.request_id}` : ""}${c.result && c.result.error ? ` - ${c.result.error}` : ""}`,
                  ),
                  ["queued", "sent", "acked"].includes(c.status)
                    ? actionBtn(
                        "Cancel",
                        async () => {
                          await api(`/commands/${c.id}/cancel`, {
                            method: "POST",
                            body: {},
                          });
                          C.reloadDrawer();
                        },
                        "sm",
                      )
                    : null,
                ),
              )
            : h("div", { class: "muted" }, "None."),
        ),
        section(
          "Zone history",
          d.assignments.map((a) =>
            h(
              "div",
              { class: "item" },
              a.zone_name,
              h(
                "div",
                { class: "muted" },
                `${fmtShort(a.assigned_from)} - ${a.assigned_until ? fmtShort(a.assigned_until) : "now"}`,
              ),
            ),
          ),
        ),
      );
    });
  }

  // =========================================================================================
  // Segments
  // =========================================================================================
  V.segments = async () => {
    const limit = 50;
    const off = Number(S.params.offset || 0);
    const d = await api(
      "/segments" +
        qs({
          status: S.params.sstatus,
          nvr_id: S.params.nvr_id,
          limit,
          offset: off,
          zone_id: S.params.zone_id,
        }),
    );
    return h(
      "div",
      {},
      head(
        "Stored segments",
        C.zoneSelect(),
        h(
          "select",
          {
            onchange: (e) => {
              S.params.sstatus = e.target.value;
              S.params.offset = 0;
              C.refresh();
            },
          },
          h("option", { value: "" }, "Any status"),
          ["complete", "partial", "pending", "failed"].map((s) =>
            h("option", { value: s, selected: s === S.params.sstatus }, s),
          ),
        ),
      ),
      table(
        [
          "#",
          "Unit / camera",
          "Start",
          "End",
          "Size",
          "Status",
          "Progress",
          "SHA-256",
        ],
        d.rows.map((s) =>
          h(
            "tr",
            {},
            h("td", {}, s.id),
            h("td", {}, `${s.nvr_name} / ${s.camera_name}`),
            h("td", {}, fmtTime(s.start_time)),
            h("td", {}, fmtTime(s.end_time)),
            h("td", {}, fmtSize(s.size_bytes)),
            h("td", {}, stBadge("seg", s.upload_status)),
            h(
              "td",
              {},
              s.upload_status === "complete"
                ? "100%"
                : `${Math.round((Number(s.bytes_received || 0) / Number(s.size_bytes)) * 100)}%`,
            ),
            h("td", { class: "mono muted" }, `${s.sha256.slice(0, 14)}...`),
          ),
        ),
        "No segments.",
      ),
      pager(+d.total, limit, off, (o) => {
        S.params.offset = o;
        C.refresh();
      }),
    );
  };

  // =========================================================================================
  // Registry: zones, posts
  // =========================================================================================
  V.registry = async () => {
    const [zones, posts] = await Promise.all([
      api("/zones"),
      api("/posts" + qs({ zone_id: S.params.zone_id })),
    ]);
    S.zones = zones;
    const postDialog = (p) =>
      C.formDialog({
        title: p ? `Edit ${p.name}` : "Add RPF post",
        submitLabel: "Save",
        fields: [
          { name: "name", label: "Post name", value: p ? p.name : "" },
          ...(!p && C.isSuper()
            ? [
                {
                  name: "zone_id",
                  label: "Zone",
                  type: "select",
                  value: zones[0] && zones[0].id,
                  options: zones.map((z) => ({ value: z.id, label: z.name })),
                },
              ]
            : []),
          {
            name: "lat",
            label: "Latitude",
            type: "number",
            step: "any",
            value: p ? p.lat : "",
          },
          {
            name: "lon",
            label: "Longitude",
            type: "number",
            step: "any",
            value: p ? p.lon : "",
          },
          {
            name: "alert_email",
            label: "Alert e-mail (optional)",
            type: "email",
            value: p && p.alert_email ? p.alert_email : "",
            hint: "Alerts, incidents and other notices for this post are also e-mailed here (needs e-mail turned on under Settings).",
          },
          {
            name: "alert_phone",
            label: "Alert mobile (optional)",
            type: "tel",
            value: p && p.alert_phone ? p.alert_phone : "",
            hint: "SMS goes to this number. Write it with the country code, e.g. +919876543210 (a 10-digit Indian number also works).",
          },
          ...(p
            ? [
                {
                  name: "active",
                  label: "Active (receives alerts)",
                  type: "checkbox",
                  value: p.active,
                },
              ]
            : []),
        ],
        submit: async (v) => {
          const body = {
            ...v,
            lat: Number(v.lat),
            lon: Number(v.lon),
            zone_id: v.zone_id ? Number(v.zone_id) : undefined,
          };
          if (p) await api(`/posts/${p.id}`, { method: "PATCH", body });
          else await api("/posts", { method: "POST", body });
          C.refresh();
        },
      });
    return h(
      "div",
      {},
      head(
        "Zones",
        C.isSuper()
          ? h(
              "button",
              {
                class: "btn",
                onclick: () =>
                  C.formDialog({
                    title: "Add zone",
                    fields: [{ name: "name", label: "Zone name" }],
                    submit: async (v) => {
                      await api("/zones", { method: "POST", body: v });
                      C.refresh();
                    },
                  }),
              },
              "Add zone",
            )
          : null,
      ),
      table(
        ["Zone", "Posts", "NVRs", "Users"],
        zones.map((z) =>
          h(
            "tr",
            {},
            h("td", {}, h("b", {}, z.name)),
            h("td", {}, z.posts),
            h("td", {}, z.nvrs),
            h("td", {}, z.users),
          ),
        ),
        "No zones.",
      ),
      head(
        "RPF posts",
        C.zoneSelect(),
        C.isAdmin()
          ? h(
              "button",
              { class: "btn primary", onclick: () => postDialog(null) },
              "Add post",
            )
          : null,
      ),
      table(
        [
          "Post",
          "Zone",
          "Location",
          "Alert contacts",
          "Officers",
          "Unacked alerts",
          "Active",
          "",
        ],
        posts.map((p) =>
          h(
            "tr",
            {},
            h("td", {}, h("b", {}, p.name)),
            h("td", {}, p.zone_name),
            h("td", {}, C.mapLink(p.lat, p.lon)),
            h(
              "td",
              { class: "muted" },
              p.alert_email || p.alert_phone
                ? [p.alert_email, p.alert_email && p.alert_phone ? h("br") : null, p.alert_phone]
                : "-",
            ),
            h("td", {}, p.officers),
            h("td", {}, +p.unacked ? badge(p.unacked, "red") : "0"),
            h(
              "td",
              {},
              p.active ? badge("active", "green") : badge("inactive", "grey"),
            ),
            h(
              "td",
              {},
              C.isAdmin()
                ? h(
                    "button",
                    { class: "btn sm", onclick: () => postDialog(p) },
                    "Edit",
                  )
                : null,
            ),
          ),
        ),
        "No posts.",
      ),
    );
  };

  // =========================================================================================
  // Users
  // =========================================================================================
  V.users = async () => {
    const rows = await api("/users");
    const posts = await api("/posts");
    const secret = (r) => {
      const d = C.dialog({
        title: "Password",
        body: [
          h("p", {}, `Give this to ${r.username} now - it is shown once.`),
          h("div", { class: "secret mono" }, r.password),
          h(
            "div",
            { class: "foot" },
            h(
              "button",
              { class: "btn primary", onclick: () => d.close() },
              "Done",
            ),
          ),
        ],
      });
    };
    const createDialog = () => {
      const roles = C.isSuper()
        ? ["operator", "post_user", "zone_admin", "super_admin"]
        : ["operator", "post_user"];
      C.formDialog({
        title: "Add user",
        submitLabel: "Create",
        sub: "A password is generated and shown once.",
        fields: [
          { name: "username", label: "Username" },
          {
            name: "role",
            label: "Role",
            type: "select",
            value: "operator",
            options: roles.map((r) => ({ value: r, label: label(r) })),
          },
          ...(C.isSuper()
            ? [
                {
                  name: "zone_id",
                  label: "Zone (not for super admin)",
                  type: "select",
                  value: S.zones[0] && S.zones[0].id,
                  options: S.zones.map((z) => ({ value: z.id, label: z.name })),
                },
              ]
            : []),
          {
            name: "post_id",
            label: "Post (post_user only)",
            type: "select",
            value: "",
            options: [
              { value: "", label: "-" },
              ...posts.map((p) => ({
                value: p.id,
                label: `${p.name} (${p.zone_name})`,
              })),
            ],
          },
        ],
        submit: async (v) => {
          const r = await api("/users", {
            method: "POST",
            body: {
              username: v.username,
              role: v.role,
              zone_id: v.zone_id ? Number(v.zone_id) : undefined,
              post_id: v.post_id ? Number(v.post_id) : undefined,
            },
          });
          C.refresh();
          setTimeout(() => secret(r), 50);
        },
      });
    };
    return h(
      "div",
      {},
      head(
        "Users",
        C.zoneSelect(),
        h(
          "button",
          { class: "btn primary", onclick: createDialog },
          "Add user",
        ),
      ),
      table(
        ["User", "Role", "Zone", "Post", "Status", ""],
        rows.map((u) =>
          h(
            "tr",
            {},
            h("td", {}, h("b", {}, u.username)),
            h("td", {}, label(u.role)),
            h("td", {}, u.zone_name || "-"),
            h("td", {}, u.post_name || "-"),
            h(
              "td",
              {},
              badge(u.status, u.status === "active" ? "green" : "grey"),
            ),
            h(
              "td",
              {},
              u.id === S.me.id
                ? h("span", { class: "muted" }, "you")
                : h(
                    "div",
                    { class: "actions" },
                    actionBtn(
                      "Reset password",
                      async () => {
                        secret(
                          await api(`/users/${u.id}/reset-password`, {
                            method: "POST",
                            body: {},
                          }),
                        );
                      },
                      "sm",
                    ),
                    actionBtn(
                      u.status === "active" ? "Disable" : "Enable",
                      async () => {
                        await api(`/users/${u.id}/status`, {
                          method: "POST",
                          body: {
                            status:
                              u.status === "active" ? "disabled" : "active",
                          },
                        });
                        C.refresh();
                      },
                      "sm",
                    ),
                  ),
            ),
          ),
        ),
        "No users.",
      ),
    );
  };

  // =========================================================================================
  // Settings, audit
  // =========================================================================================
  const kpiCard = (t, v, s, cls) =>
    h(
      "div",
      { class: `kpi ${cls || ""}` },
      h("div", { class: "kpi-t" }, t),
      h("div", { class: "kpi-v" }, v),
      s ? h("div", { class: "kpi-s" }, s) : null,
    );

  V.settings = async () => {
    const rows = (await api("/settings")).filter((r) => !/^notify_(email_enabled|sms_enabled|kinds|sms_min_priority|extra_)/.test(r.key)); // these live on the E-mail & SMS page
    const canEdit = C.isSuper();
    const inputs = {};
    const form = h(
      "form",
      { class: "card pad settings" },
      rows.map((s) => {
        let el;
        if (s.type === "choice")
          el = h(
            "select",
            { disabled: !canEdit },
            s.options.map(([v, t]) =>
              h("option", { value: v, selected: v === s.value }, t),
            ),
          );
        else if (s.type === "bool")
          el = h("input", {
            type: "checkbox",
            checked: !!s.value,
            disabled: !canEdit,
          });
        else
          el = h("input", {
            type: s.type === "int" ? "number" : "text",
            value: s.value,
            min: s.min,
            max: s.max,
            disabled: !canEdit,
          });
        inputs[s.key] = el;
        return h("div", { class: "srow" }, h("label", {}, s.label), el);
      }),
      canEdit
        ? h(
            "div",
            { class: "foot" },
            h(
              "button",
              { class: "btn primary", type: "submit" },
              "Save settings",
            ),
          )
        : h(
            "div",
            { class: "muted" },
            "Only a super admin can change settings.",
          ),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = {};
      for (const s of rows)
        body[s.key] =
          s.type === "bool" ? inputs[s.key].checked : inputs[s.key].value;
      try {
        await api("/settings", { method: "PUT", body });
        toast("Settings saved - effective immediately");
      } catch (ex) {
        toast(ex.message);
      }
    });
    return h("div", {}, head("Settings"), form);
  };

  // =========================================================================================
  // E-mail & SMS - made for a first-time user: 3 steps, only the essential fields, everything technical tucked into "more" sections
  // =========================================================================================
  // Unsaved typing in the contact boxes survives a page refresh (e.g. after saving another row), for 30 minutes or until it is saved.
  const ntDraft = {};
  const ntTrack = (key, el, saved) => {
    const d = ntDraft[key];
    if (d && Date.now() - d.t < 1800000) el.value = d.v;
    const note = () => { if (el.value === String(saved == null ? "" : saved)) delete ntDraft[key]; else ntDraft[key] = { v: el.value, t: Date.now() }; };
    el.addEventListener("input", note);
    el.addEventListener("change", note);
    return el;
  };
  const ntClear = (prefix) => Object.keys(ntDraft).filter((k) => k.startsWith(prefix)).forEach((k) => delete ntDraft[k]);
  V.notify = async () => {
    const isSuper = C.isSuper();
    const [ov, cfg, st, ruleRows] = await Promise.all([
      api("/notify/overview"),
      isSuper ? api("/notify/config") : null,
      isSuper ? api("/notify/status") : null,
      api("/settings"),
    ]);
    const R = Object.fromEntries(ruleRows.map((r) => [r.key, r.value]));
    const F = cfg ? Object.fromEntries(cfg.fields.map((f) => [f.key, f])) : {};
    let uid = 0;
    const field = (label, control, o = {}) => {
      const linkable = /^(INPUT|SELECT)$/.test(control.tagName); // label <-> box: clicking the label focuses the box, screen readers read it
      if (linkable) control.id = "nt-f" + ++uid;
      return h("div", { class: "nt-field" + (o.wide ? " wide" : "") }, h("label", { for: linkable ? control.id : null }, label), control, o.hint ? h("div", { class: "hint" }, o.hint) : null);
    };
    const more = (title, open, ...kids) => h("details", { class: "nt-more", open: open ? true : null }, h("summary", {}, title), h("div", { class: "nt-moreinner" }, kids));
    const stepCard = (n, title, sub, ...kids) => h("section", { class: "nt-card" }, h("header", {}, h("span", { class: "num" }, n), h("div", {}, h("h3", {}, title), h("p", { class: "sub" }, sub))), kids);
    const chip = (text, cls, tip) => h("span", { class: "nt-chip " + (cls || ""), title: tip || null }, text);
    const NEED = { SMTP_HOST: "mail server", SMTP_PORT: "port", EMAIL_FROM: "sender address", SMTP_PASSWORD: "password", FAST2SMS_API_URL: "gateway address (config file)", FAST2SMS_API_KEY: "API key", FAST2SMS_SENDER_ID: "sender ID", FAST2SMS_DLT_TEMPLATE_ID: "template ID", TWILIO_ACCOUNT_SID: "Account SID", TWILIO_AUTH_TOKEN: "Auth token", "TWILIO_FROM (or TWILIO_MESSAGING_SERVICE_SID)": "Twilio number", TWILIO_API_URL: "gateway address (config file)" };
    const needs = (r) => { const l = r.missing.map((m) => NEED[m]).filter(Boolean); return l.length ? "Still needed: " + l.join(", ") + "." : ""; };

    const mails = ov.posts.filter((p) => p.alert_email).length;
    const phones = ov.posts.filter((p) => p.alert_phone).length;
    const s1 = ov.email.configured || ov.sms.configured;
    const s2 = mails + phones > 0;
    const s3 = ov.email.enabled || ov.sms.enabled;

    // ---- header + progress ---------------------------------------------------------------------
    const top = h("div", { class: "nt-top" }, h("h2", {}, "E-mail & SMS alerts"),
      h("p", { class: "nt-lead" }, isSuper ? "Get an e-mail and/or an SMS whenever an alert reaches a post. Three quick steps - each one turns green when it is done." : "Choose where the alerts of your posts are sent by e-mail and SMS."));
    const stepper = h("div", { class: "nt-steps" }, [
      ["1", "Connect", s1, s1 ? [ov.email.configured ? "E-mail" : null, ov.sms.configured ? "SMS" : null].filter(Boolean).join(" + ") + " ready" : "Not done yet"],
      ["2", "Add contacts", s2, s2 ? `${mails} e-mail, ${phones} mobile` : "Not done yet"],
      ["3", "Switch on", s3, s3 ? [ov.email.enabled ? "E-mail" : null, ov.sms.enabled ? "SMS" : null].filter(Boolean).join(" + ") + " on" : "Not done yet"],
    ].map(([n, t, done, s]) => h("div", { class: "nt-step" + (done ? " done" : "") }, h("span", { class: "num" }, done ? "✓" : n), h("div", {}, h("b", {}, t), h("span", { class: "s" }, s)))));

    // ---- step 1: providers ---------------------------------------------------------------------
    const tile = (kind) => {
      const isMail = kind === "email";
      const r = isMail ? ov.email : ov.sms;
      const inputs = {};
      const mk = (key, label, o = {}) => {
        const f = F[key];
        let c;
        if (f.type === "choice") {
          c = h("select", {}, f.options.map((op) => h("option", { value: op, selected: op === f.value }, (o.names && o.names[op]) || op)));
          if (!f.value) c.value = f.options[0];
        } else {
          c = h("input", { type: f.secret ? "password" : f.type === "port" ? "number" : "text", value: f.value, autocomplete: "off", placeholder: f.secret && f.set ? "saved - leave empty to keep" : o.ph || "" });
        }
        inputs[key] = c;
        return field(label, c, { wide: o.wide });
      };
      const presets = cfg.presets[kind] || [];
      const help = h("div", { class: "nt-help hidden" });
      const showHelp = (p) => { help.textContent = p ? p.help : ""; help.classList.toggle("hidden", !p); };
      let startId = "";
      if (isMail) { const hit = presets.find((p) => p.values.SMTP_HOST && p.values.SMTP_HOST === F.SMTP_HOST.value); startId = hit ? hit.id : F.SMTP_HOST.value ? "other" : ""; }
      else startId = presets.some((p) => p.id === F.SMS_PROVIDER.value) ? F.SMS_PROVIDER.value : "";
      const sel = h("select", {}, h("option", { value: "" }, "Choose…"), presets.map((p) => h("option", { value: p.id, selected: p.id === startId }, p.label)));
      sel.value = startId;
      let body, adv;
      if (isMail) {
        body = [mk("SMTP_USER", "Login (usually your e-mail)", { ph: "you@example.com" }), mk("SMTP_PASSWORD", "Password or key"), mk("EMAIL_FROM", "Send e-mails from", { wide: true, ph: "you@example.com" })];
        adv = more("Advanced: mail server", startId === "other", h("div", { class: "nt-form" }, mk("SMTP_HOST", "Mail server", { wide: true }), mk("SMTP_PORT", "Port"), mk("SMTP_SECURE", "Encryption", { names: { starttls: "Standard (STARTTLS)", ssl: "SSL", none: "None" } })));
      } else {
        const fast = h("div", { class: "nt-form" }, mk("FAST2SMS_API_KEY", "Fast2SMS API key", { wide: true }));
        const tw = h("div", { class: "nt-form" }, mk("TWILIO_ACCOUNT_SID", "Account SID", { wide: true }), mk("TWILIO_AUTH_TOKEN", "Auth token"), mk("TWILIO_FROM", "Your Twilio number", { ph: "+1 415 555 0123" }));
        const sync = () => { fast.classList.toggle("hidden", sel.value !== "fast2sms"); tw.classList.toggle("hidden", sel.value !== "twilio"); };
        sel.addEventListener("change", sync);
        sync();
        body = [fast, tw];
        adv = more("Advanced", false, h("div", { class: "nt-form" }, mk("SMS_DEFAULT_COUNTRY_CODE", "Default country code", { ph: "91" }), mk("FAST2SMS_ROUTE", "Fast2SMS type", { names: { q: "Quick SMS", dlt: "DLT template" } }), mk("FAST2SMS_SENDER_ID", "Fast2SMS sender ID (DLT only)"), mk("FAST2SMS_DLT_TEMPLATE_ID", "Fast2SMS template ID (DLT only)"), mk("TWILIO_MESSAGING_SERVICE_SID", "Twilio messaging service (instead of a number)", { wide: true })));
      }
      sel.addEventListener("change", () => {
        const p = presets.find((x) => x.id === sel.value);
        showHelp(p);
        if (p) for (const [k, v] of Object.entries(p.values)) if (inputs[k]) inputs[k].value = v;
        if (p && p.id === "other") adv.open = true;
      });
      showHelp(presets.find((p) => p.id === startId));
      const save = actionBtn("Save", async () => {
        const values = {};
        for (const k of Object.keys(inputs)) values[k] = inputs[k].value;
        if (isMail) values.EMAIL_PROVIDER = inputs.SMTP_HOST.value.trim() ? "smtp" : "none";
        else values.SMS_PROVIDER = sel.value || "none";
        await api("/notify/config", { method: "PUT", body: { values } });
        toast("Saved");
        C.refresh();
      }, "primary");
      const refreshSave = () => { save.disabled = isMail ? !(sel.value || inputs.SMTP_HOST.value.trim()) : !sel.value; }; // nothing to save until a service is chosen
      refreshSave();
      sel.addEventListener("change", refreshSave);
      if (isMail) inputs.SMTP_HOST.addEventListener("input", refreshSave);
      const to = h("input", { placeholder: isMail ? "your e-mail address" : "your mobile, e.g. +91 98765 43210", autocomplete: "off" });
      const test = actionBtn("Send test", async () => {
        const res = await api("/notify/test", { method: "POST", body: { channel: kind, to: to.value } });
        toast("Test sent" + (res.ref ? " (" + res.ref + ")" : "") + " - check your " + (isMail ? "inbox (and spam folder)" : "phone"));
      });
      const form = [field(isMail ? "E-mail service" : "SMS service", sel, { wide: true }), help, h("div", { class: isMail ? "nt-form" : "" }, body), adv, h("div", { class: "nt-actions" }, save)]; // SMS: the two provider groups are already grids
      return h("div", { class: "nt-tile" },
        h("div", { class: "nt-tilehead" }, h("h4", {}, isMail ? "E-mail" : "SMS"), r.configured ? chip("Connected", "ok") : chip("Not connected", "warn")),
        r.configured ? field("Check that it works", h("div", { class: "nt-test" }, to, test)) : (needs(r) ? h("div", { class: "hint" }, needs(r)) : null),
        r.configured ? more("Change settings", false, form) : h("div", { class: "nt-moreinner" }, form));
    };
    const step1 = isSuper ? stepCard("1", "Connect a service to send messages", "Do this once. You need a free account with an e-mail and/or SMS company - the help text appears when you choose one.", h("div", { class: "nt-tiles" }, tile("email"), tile("sms"))) : null;

    // ---- step 2: contacts ------------------------------------------------------------------------
    const postRow = (p) => {
      const em = h("input", { type: "email", value: p.alert_email || "", placeholder: "name@example.com", autocomplete: "off" });
      const ph = h("input", { type: "tel", value: p.alert_phone || "", placeholder: "+91 98765 43210", autocomplete: "off" });
      const save = actionBtn("Save", async () => {
        await api(`/posts/${p.id}`, { method: "PATCH", body: { alert_email: em.value, alert_phone: ph.value } });
        ntClear(`post:${p.id}:`);
        toast(`Saved - ${p.name}`);
        C.refresh();
      }, "sm primary");
      ntTrack(`post:${p.id}:email`, em, p.alert_email || "");
      ntTrack(`post:${p.id}:phone`, ph, p.alert_phone || "");
      const dirty = () => { save.disabled = em.value.trim() === (p.alert_email || "") && ph.value.trim() === (p.alert_phone || ""); };
      dirty();
      em.addEventListener("input", dirty);
      ph.addEventListener("input", dirty);
      const chips = [];
      if (!p.active) chips.push(chip("Post is inactive", "", "Inactive posts get no alerts"));
      const one = (name, has, r, tip) => { if (!has) return; chips.push(!r.enabled ? chip(name + " is off", "", "Turn it on in step 3") : !r.configured ? chip(name + " not connected", "warn", "Do step 1") : chip(name + " ✓", "ok", tip)); };
      one("E-mail", p.alert_email, ov.email, "Alerts will be e-mailed here");
      one("SMS", p.alert_phone, ov.sms, "Alerts will be texted here");
      return h("div", { class: "nt-post" }, h("div", { class: "who" }, h("b", {}, p.name), h("small", {}, p.zone_name)), em, ph, save, chips.length ? h("div", { class: "nt-chips" }, chips) : null);
    };
    let copies = null;
    if (isSuper) {
      const xe = h("input", { value: ov.extras.emails.join(", "), placeholder: "supervisor@example.com", autocomplete: "off" });
      const xp = h("input", { value: ov.extras.phones.join(", "), placeholder: "+91 98765 43210", autocomplete: "off" });
      ntTrack("copies:emails", xe, ov.extras.emails.join(", "));
      ntTrack("copies:phones", xp, ov.extras.phones.join(", "));
      copies = more("Also send a copy of every message to the control room", ov.extras.emails.length + ov.extras.phones.length > 0 || Object.keys(ntDraft).some((k) => k.startsWith("copies:")),
        h("div", { class: "nt-form" }, field("E-mail addresses", xe, { hint: "Separate several with commas." }), field("Mobile numbers", xp, { hint: "Separate several with commas." })),
        h("div", { class: "nt-actions" }, actionBtn("Save", async () => {
          await api("/settings", { method: "PUT", body: { notify_extra_emails: xe.value, notify_extra_phones: xp.value } });
          ntClear("copies:");
          toast("Saved");
          C.refresh();
        }, "primary")));
    }
    const step2 = stepCard(isSuper ? "2" : "•", isSuper ? "Who should receive the alerts?" : "Where your posts' alerts are sent", "An alert sent to a post is e-mailed and texted to the contacts on that post's row. Leave a box empty to skip that way of sending.",
      ov.posts.length
        ? [h("div", { class: "nt-cols" }, h("span", {}, "Post"), h("span", {}, "E-mail"), h("span", {}, "Mobile (with country code)"), h("span", {})), h("div", { class: "nt-posts" }, ov.posts.map(postRow))]
        : h("div", { class: "nt-posts" }, h("div", { class: "nt-empty" }, "No posts yet. Add them under Administration > Zones & posts.")),
      copies);

    // ---- step 3: switches + rules -----------------------------------------------------------------
    let step3 = null;
    if (isSuper) {
      const sw = (key, title, desc, on, ready) => {
        const cb = h("input", { type: "checkbox", checked: !!on });
        cb.addEventListener("change", async () => {
          try { await api("/settings", { method: "PUT", body: { [key]: cb.checked } }); toast(title + (cb.checked ? " turned on" : " turned off")); C.refresh(); }
          catch (ex) { cb.checked = !cb.checked; toast(ex.message); }
        });
        return h("div", { class: "nt-switchrow" }, h("div", {}, h("b", {}, title), h("div", { class: "hint" }, desc), !ready ? h("div", { class: "nt-warn" }, "Not connected yet - finish step 1 first.") : null), h("label", { class: "nt-switch", title }, cb, h("span", { class: "nt-slider" })));
      };
      const KINDS = [["alert", "New alerts"], ["incident", "Incidents raised by officers"], ["request", "Footage request updates"], ["footage", "Footage delivered"], ["evidence", "Evidence flags"]];
      const have = String(R.notify_kinds || "").split(/[,;\s]+/).filter(Boolean);
      const kinds = KINDS.map(([k]) => h("input", { type: "checkbox", checked: have.includes(k) }));
      const prio = h("select", {}, Array.from({ length: 10 }, (_, i) => h("option", { value: i + 1, selected: i + 1 === Number(R.notify_sms_min_priority) }, i === 0 ? "All alerts" : `Priority ${i + 1} and higher`)));
      step3 = stepCard("3", "Switch it on", "Turn on the ways you want to be notified. It takes effect immediately.",
        h("div", { class: "nt-switches" },
          sw("notify_email_enabled", "E-mail alerts", "Send an e-mail when an alert reaches a post.", R.notify_email_enabled, ov.email.configured),
          sw("notify_sms_enabled", "SMS alerts", "Send an SMS when an alert reaches a post.", R.notify_sms_enabled, ov.sms.configured)),
        more("More options: which messages, SMS priority, preview", false,
          field("Which messages are sent", h("div", { class: "nt-checks" }, KINDS.map(([k, t], i) => h("label", { class: "nt-check" }, kinds[i], t))), { wide: true }),
          field("Send SMS for", prio, { hint: "Lower-priority alerts are still e-mailed. SMS costs money, so you may prefer 7 and higher." }),
          h("div", { class: "nt-actions" }, actionBtn("Save", async () => {
            await api("/settings", { method: "PUT", body: { notify_kinds: KINDS.filter((_, i) => kinds[i].checked).map(([k]) => k).join(","), notify_sms_min_priority: prio.value } });
            toast("Saved");
            C.refresh();
          }, "primary")),
          field("What a message looks like", h("div", {}, h("div", { class: "hint" }, "E-mail subject: " + ov.sample.subject), h("pre", { class: "nt-pre mono" }, ov.sample.text), h("div", { class: "hint" }, "SMS: " + ov.sample.sms)), { wide: true })));
    }

    // ---- recent messages (closed by default) -------------------------------------------------------
    let log = null;
    if (isSuper) {
      const col = { sent: "green", pending: "amber", failed: "red", expired: "grey", skipped: "grey" };
      const sum = st.last_24h.reduce((a, x) => { a[x.status] = (a[x.status] || 0) + x.n; return a; }, {});
      const summary = Object.keys(sum).length ? "last 24 h: " + Object.entries(sum).map(([k, v]) => `${v} ${k}`).join(", ") : "nothing sent yet";
      log = h("details", { class: "nt-card nt-log", open: st.recent.some((d) => d.status === "failed" || d.status === "pending") ? true : null },
        h("summary", {}, "Recent messages", h("span", { class: "muted" }, summary)),
        h("div", { class: "nt-logbody" },
          h("div", { class: "nt-actions" }, actionBtn("Refresh", async () => C.refresh()), actionBtn("Send failed ones again", async () => { const x = await api("/notify/retry", { method: "POST", body: {} }); toast(x.requeued + " message(s) queued again"); C.refresh(); })),
          h("div", { class: "nt-scroll" }, table(["When", "Type", "To", "Result"],
            st.recent.slice(0, 15).map((d) => h("tr", {}, h("td", {}, fmtTime(d.created_at)), h("td", {}, d.channel === "sms" ? "SMS" : "E-mail"), h("td", {}, d.recipient), h("td", {}, badge(d.status, col[d.status] || "grey"), d.last_error ? h("span", { class: "nt-err" }, d.last_error) : null))),
            "Nothing sent yet. Once the steps above are done, the next alert (or a test message) shows up here."))));
    }

    return h("div", { class: "nt" }, top, isSuper ? stepper : null, step1, step2, step3, log);
  };

  V.audit = async () => {
    const limit = 100;
    const off = Number(S.params.offset || 0);
    const f = S.params;
    const d = await api(
      "/audit" +
        qs({
          action: f.aaction,
          entity: f.aentity,
          actor: f.aactor,
          from: f.afrom,
          limit,
          offset: off,
          zone_id: f.zone_id,
        }),
    );
    const txt = (name, ph) =>
      h("input", {
        placeholder: ph,
        value: f[name] || "",
        onchange: (e) => {
          f[name] = e.target.value.trim();
          f.offset = 0;
          C.refresh();
        },
      });
    return h(
      "div",
      {},
      head(
        "Audit trail",
        C.zoneSelect(),
        txt("aaction", "action prefix, e.g. footage."),
        txt("aactor", "user"),
        h("input", {
          type: "date",
          value: f.afrom || "",
          onchange: (e) => {
            f.afrom = e.target.value;
            C.refresh();
          },
        }),
        C.isAdmin()
          ? actionBtn(
              "Export CSV",
              async () => {
                const res = await fetch(
                  `/console/api/audit.csv${qs({ action: f.aaction, actor: f.aactor, from: f.afrom, zone_id: f.zone_id })}`,
                  { headers: { Authorization: `Bearer ${S.token}` } },
                );
                if (!res.ok) throw new Error("export failed");
                const url = URL.createObjectURL(await res.blob());
                C.download(url);
                setTimeout(() => URL.revokeObjectURL(url), 5000);
              },
              "sm",
            )
          : null,
      ),
      table(
        ["#", "When", "Who", "Action", "Entity", "Details"],
        d.rows.map((a) =>
          h(
            "tr",
            {},
            h("td", {}, a.id),
            h("td", {}, fmtTime(a.occurred_at)),
            h("td", {}, a.actor || "system"),
            h("td", {}, h("b", {}, a.action)),
            h("td", {}, `${a.entity}${a.entity_id ? ` #${a.entity_id}` : ""}`),
            h(
              "td",
              { class: "mono muted clip" },
              a.details ? JSON.stringify(a.details) : "",
            ),
          ),
        ),
        "No entries.",
      ),
      pager(+d.total, limit, off, (o) => {
        f.offset = o;
        C.refresh();
      }),
    );
  };
})();
