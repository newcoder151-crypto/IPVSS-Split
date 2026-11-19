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
    const pointer = h(
      "div",
      { class: "card pad" },
      "E-mail and SMS alerts (providers, who receives what, rules, delivery log) have their own page: ",
      h("a", { href: "#", onclick: (e) => { e.preventDefault(); C.go("notify"); } }, "Administration > E-mail & SMS"),
      ".",
    );
    return h("div", {}, head("Settings"), form, pointer);
  };

  // =========================================================================================
  // E-mail & SMS: connect a provider, say who receives what, rules, delivery log
  // =========================================================================================
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
    const card = (title, ...kids) => h("div", { class: "card pad settings" }, h("h3", {}, title), kids);
    const row = (label, el, hint) => h("div", { class: "srow" }, h("label", {}, label), h("div", {}, el, hint ? h("div", { class: "hint" }, hint) : null));

    // ---- 0. how it works + what is still missing ----------------------------------------
    const withMail = ov.posts.filter((p) => p.alert_email).length;
    const withPhone = ov.posts.filter((p) => p.alert_phone).length;
    const chk = (ok, text, warn) => h("div", {}, ok ? badge("done", "green") : badge("to do", warn || "red"), " ", text);
    const how = card(
      "How alerts reach people",
      h("p", {}, "When the CMS sends an alert or an incident to an RPF post, the officers see it in the RPF dashboard as before. With this page the same message is ALSO e-mailed to that post's alert e-mail and texted to that post's alert mobile number. If an alert is escalated to another post, that post's contacts are used. People you list under 'Control-room copies' receive every message."),
      h("p", { class: "hint" }, "Three steps. Each line below turns green when it is done."),
      chk(ov.email.configured || ov.sms.configured, isSuper ? "1. Connect an e-mail and/or SMS provider" : "1. A provider is connected (super admin does this)"),
      chk(withMail + withPhone > 0, `2. Fill each post's alert e-mail / mobile (${withMail} of ${ov.posts.length} posts have an e-mail, ${withPhone} have a mobile number)`),
      chk(ov.email.enabled || ov.sms.enabled, `3. Switch the channels on (e-mail: ${ov.email.enabled ? "on" : "off"}, SMS: ${ov.sms.enabled ? "on" : "off"})`),
    );

    // ---- 1. providers (super admin) ----------------------------------------------------------
    const providerCard = (kind) => {
      const inputs = {};
      const isMail = kind === "email";
      const keys = isMail
        ? [["EMAIL_PROVIDER", "Send e-mail with"], ["SMTP_HOST", "Mail server (SMTP host)"], ["SMTP_PORT", "Port"], ["SMTP_SECURE", "Encryption"], ["SMTP_USER", "Login (user name)"], ["SMTP_PASSWORD", "Password"], ["EMAIL_FROM", "Sender shown on the e-mail"]]
        : [["SMS_PROVIDER", "Send SMS with"], ["SMS_DEFAULT_COUNTRY_CODE", "Country code for numbers written without one"], ["FAST2SMS_API_KEY", "Fast2SMS: API key"], ["FAST2SMS_ROUTE", "Fast2SMS: route"], ["FAST2SMS_SENDER_ID", "Fast2SMS: sender ID (DLT route only)"], ["FAST2SMS_DLT_TEMPLATE_ID", "Fast2SMS: template ID (DLT route only)"], ["TWILIO_ACCOUNT_SID", "Twilio: Account SID"], ["TWILIO_AUTH_TOKEN", "Twilio: Auth token"], ["TWILIO_FROM", "Twilio: your Twilio number"], ["TWILIO_MESSAGING_SERVICE_SID", "Twilio: messaging service SID (instead of number)"]];
      const make = ([key, label]) => {
        const f = F[key];
        let el;
        if (f.type === "choice") el = h("select", {}, f.options.map((o) => h("option", { value: o, selected: o === f.value }, o === "none" ? "none (off)" : o)));
        else el = h("input", { type: f.secret ? "password" : f.type === "port" ? "number" : "text", value: f.value, autocomplete: "off", placeholder: f.secret && f.set ? "saved - leave empty to keep it" : "" });
        if (f.type === "choice" && !f.value) el.value = f.options[0];
        inputs[key] = el;
        return row(label, el, f.source === "file" && f.value ? "from config/notify.conf" : f.secret && f.set ? (f.source === "console" ? "saved from this page" : "set in config/notify.conf") : null);
      };
      const help = h("div", { class: "hint" });
      const presets = cfg.presets[kind] || [];
      const preset = h("select", {}, h("option", { value: "" }, "- pick your provider to fill the form -"), presets.map((p) => h("option", { value: p.id }, p.label)));
      preset.addEventListener("change", () => {
        const p = presets.find((x) => x.id === preset.value);
        help.textContent = p ? p.help : "";
        if (p) for (const [k, v] of Object.entries(p.values)) if (inputs[k]) inputs[k].value = v;
      });
      const rowsEl = keys.map(make);
      const to = h("input", { placeholder: isMail ? "your e-mail address" : "+91 mobile number", autocomplete: "off" });
      const save = actionBtn("Save", async () => {
        const values = {};
        for (const [k] of keys) values[k] = inputs[k].value;
        await api("/notify/config", { method: "PUT", body: { values } });
        toast("Saved. Now press 'Send test'.");
        C.refresh();
      }, "primary");
      const test = actionBtn("Send test", async () => {
        const r = await api("/notify/test", { method: "POST", body: { channel: kind, to: to.value } });
        toast("Sent" + (r.ref ? " (" + r.ref + ")" : "") + " - check the " + (isMail ? "inbox (and spam)" : "phone"));
        C.refresh();
      });
      const gw = isMail ? null : h("div", { class: "hint" }, "Gateway addresses (change in config/notify.conf): Fast2SMS " + (cfg.gateways.fast2sms || "-") + " - Twilio " + (cfg.gateways.twilio || "-"));
      const r = isMail ? ov.email : ov.sms;
      return card(
        (isMail ? "E-mail" : "SMS") + " provider  ",
        h("div", {}, r.configured ? badge("connected: " + r.provider, "green") : badge("not connected", "red"), r.missing.length ? h("div", { class: "hint" }, "Still missing: " + r.missing.join(", ")) : null),
        row("Provider", preset, null),
        help,
        rowsEl,
        gw,
        h("div", { class: "foot" }, save),
        row("Test message to", h("div", {}, to, " ", test), "Uses the SAVED settings, and shows the provider's own answer if it fails."),
      );
    };

    // ---- 2. who receives what ------------------------------------------------------------------
    const reach = (p) => {
      const out = [];
      if (!p.active) out.push(badge("inactive post - gets no alerts", "grey"));
      const one = (name, value, r) => !value ? badge(name + ": no contact", "grey") : !r.enabled ? badge(name + ": switched off", "grey") : !r.configured ? badge(name + ": provider not connected", "amber") : badge(name + ": will be sent", "green");
      out.push(one("e-mail", p.alert_email, ov.email), " ", one("SMS", p.alert_phone, ov.sms));
      return out;
    };
    const postRow = (p) => {
      const em = h("input", { type: "email", value: p.alert_email || "", placeholder: "name@example.com", autocomplete: "off" });
      const ph = h("input", { type: "tel", value: p.alert_phone || "", placeholder: "+91 98765 43210", autocomplete: "off" });
      const save = actionBtn("Save", async () => {
        await api(`/posts/${p.id}`, { method: "PATCH", body: { alert_email: em.value, alert_phone: ph.value } });
        toast(`Saved contacts of ${p.name}`);
        C.refresh();
      }, "sm");
      return h("tr", {}, h("td", {}, h("b", {}, p.name), h("div", { class: "hint" }, p.zone_name)), h("td", {}, em), h("td", {}, ph), h("td", {}, reach(p)), h("td", {}, save));
    };
    const contacts = h(
      "div",
      {},
      card("2. Who receives the alerts", h("div", { class: "hint" }, "Each post's alerts go to the e-mail and mobile number written on its row. Leave a field empty to send nothing on that channel. Write mobile numbers with the country code (+91...); a 10-digit Indian number also works.")),
      table(["Post", "Alert e-mail", "Alert mobile", "What will happen", ""], ov.posts.map(postRow), "No posts yet - add them under Zones & posts."),
    );
    let extras = null;
    if (isSuper) {
      const xe = h("input", { value: ov.extras.emails.join(", "), placeholder: "supervisor@example.com, control@example.com", autocomplete: "off" });
      const xp = h("input", { value: ov.extras.phones.join(", "), placeholder: "+919876543210, +919123456789", autocomplete: "off" });
      extras = card(
        "Control-room copies (optional)",
        h("div", { class: "hint" }, "These people receive a copy of EVERY outgoing message, whichever post it was for."),
        row("E-mail addresses (comma separated)", xe),
        row("Mobile numbers (comma separated)", xp),
        h("div", { class: "foot" }, actionBtn("Save copies", async () => {
          await api("/settings", { method: "PUT", body: { notify_extra_emails: xe.value, notify_extra_phones: xp.value } });
          toast("Saved");
          C.refresh();
        }, "primary")),
      );
    }

    // ---- 3. rules (super admin) ---------------------------------------------------------------
    let rules = null;
    if (isSuper) {
      const onE = h("input", { type: "checkbox", checked: !!R.notify_email_enabled });
      const onS = h("input", { type: "checkbox", checked: !!R.notify_sms_enabled });
      const KINDS = [["alert", "Alerts sent to a post (and 'alert dismissed')"], ["incident", "Incidents raised by officers"], ["request", "Footage request updates"], ["footage", "Footage delivered"], ["evidence", "Evidence flags"]];
      const have = String(R.notify_kinds || "").split(/[,;\s]+/).filter(Boolean);
      const kinds = KINDS.map(([k]) => h("input", { type: "checkbox", checked: have.includes(k) }));
      const prio = h("select", {}, Array.from({ length: 10 }, (_, i) => h("option", { value: i + 1, selected: i + 1 === Number(R.notify_sms_min_priority) }, i + 1 === 1 ? "1 - every alert" : String(i + 1))));
      const sm = ov.sample;
      rules = card(
        "3. Rules",
        row("Send e-mail", onE, "Master switch for e-mail."),
        row("Send SMS", onS, "Master switch for SMS."),
        row("Which messages go out", h("div", {}, KINDS.map(([k, t], i) => h("div", {}, kinds[i], " ", t)))),
        row("SMS only for alerts of priority", prio, "Lower-priority alerts are still e-mailed. SMS costs money, so you may want 7 or higher."),
        h("div", { class: "foot" }, actionBtn("Save rules", async () => {
          await api("/settings", { method: "PUT", body: { notify_email_enabled: onE.checked, notify_sms_enabled: onS.checked, notify_kinds: KINDS.filter((_, i) => kinds[i].checked).map(([k]) => k).join(","), notify_sms_min_priority: prio.value } });
          toast("Saved - effective immediately");
          C.refresh();
        }, "primary")),
        h("h3", {}, "What a message looks like"),
        h("div", { class: "hint" }, "E-mail subject: " + sm.subject),
        h("pre", { class: "mono" }, sm.text),
        h("div", { class: "hint" }, "SMS text: " + sm.sms),
      );
    }

    // ---- delivery log (super admin) -----------------------------------------------------------
    let log = null;
    if (isSuper) {
      const col = { sent: "green", pending: "amber", failed: "red", expired: "grey", skipped: "grey" };
      log = h(
        "div",
        {},
        head("Delivery log", st.last_24h.length ? h("span", { class: "muted" }, "last 24 h: " + st.last_24h.map((x) => x.n + " " + x.channel + " " + x.status).join(", ")) : null,
          actionBtn("Refresh", async () => C.refresh()),
          actionBtn("Retry failed (last 24 h)", async () => { const r = await api("/notify/retry", { method: "POST", body: {} }); toast(r.requeued + " message(s) queued again"); C.refresh(); })),
        table(
          ["Time", "Channel", "To", "Notice", "Post", "Status", "Tries", "Detail"],
          st.recent.map((d) => h("tr", {}, h("td", {}, fmtTime(d.created_at)), h("td", {}, d.channel), h("td", {}, d.recipient), h("td", {}, d.kind), h("td", {}, d.post_name || "-"), h("td", {}, badge(d.status, col[d.status] || "grey")), h("td", {}, d.attempts), h("td", { class: "muted" }, d.last_error || (d.sent_at ? "sent " + fmtShort(d.sent_at) : "")))),
          "Nothing sent yet. After steps 1-3, the next alert (or a test message) appears here.",
        ),
      );
    }

    return h(
      "div",
      {},
      head("E-mail & SMS alerts"),
      how,
      isSuper ? h("div", {}, head("1. Connect a provider"), providerCard("email"), providerCard("sms")) : null,
      contacts,
      extras,
      rules,
      log,
    );
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
