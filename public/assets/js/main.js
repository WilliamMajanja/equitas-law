/* ==========================================================================
   Equitas Law — main.js
   Vanilla JavaScript only. No dependencies, no build step.
   ========================================================================== */
(function () {
  "use strict";

  var API = "/api";

  /* ------------------------- tiny fetch helper --------------------------- */
  function apiFetch(path, options) {
    options = options || {};
    var headers = options.headers || {};
    if (options.json) headers["Content-Type"] = "application/json";
    var key = sessionStorage.getItem("equitas_admin_key");
    if (key) headers["x-admin-key"] = key;
    return fetch(API + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.json ? JSON.stringify(options.json) : undefined,
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return { ok: false, error: "Bad server response." };
        })
        .then(function (body) {
          return { status: res.status, ok: res.ok && body.ok !== false, body: body };
        });
    });
  }

  function esc(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleDateString("en-KE", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch (e) {
      return iso;
    }
  }

  /* --------------------------- sticky header ----------------------------- */
  var header = document.querySelector(".site-header");
  if (header && !header.classList.contains("site-header--solid")) {
    var onScroll = function () {
      header.classList.toggle("is-scrolled", window.scrollY > 24);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* --------------------------- mobile navigation -------------------------- */
  var toggle = document.querySelector(".nav-toggle");
  var navLinks = document.querySelector(".nav-links");
  if (toggle && navLinks) {
    toggle.addEventListener("click", function () {
      var open = navLinks.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(open));
      document.body.style.overflow = open ? "hidden" : "";
    });
    navLinks.addEventListener("click", function (event) {
      if (event.target.closest("a")) {
        navLinks.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
        document.body.style.overflow = "";
      }
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && navLinks.classList.contains("is-open")) {
        navLinks.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
        document.body.style.overflow = "";
        toggle.focus();
      }
    });
  }

  /* --------------------------- reveal on scroll --------------------------- */
  var revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && revealEls.length) {
    var revealObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
    );
    revealEls.forEach(function (el) {
      revealObserver.observe(el);
    });
  } else {
    revealEls.forEach(function (el) {
      el.classList.add("is-visible");
    });
  }

  /* --------------------------- animated counters -------------------------- */
  var counters = document.querySelectorAll("[data-count]");
  var animateCounter = function (el) {
    var target = parseFloat(el.getAttribute("data-count"));
    var suffix = el.getAttribute("data-suffix") || "";
    var duration = 1800;
    var start = null;
    var step = function (timestamp) {
      if (!start) start = timestamp;
      var progress = Math.min((timestamp - start) / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 3);
      var value = Math.round(target * eased);
      el.textContent = value.toLocaleString("en-KE") + suffix;
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  if ("IntersectionObserver" in window && counters.length) {
    var counterObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            animateCounter(entry.target);
            counterObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.4 }
    );
    counters.forEach(function (el) {
      counterObserver.observe(el);
    });
  } else {
    counters.forEach(animateCounter);
  }

  /* ------------------------------ footer year ----------------------------- */
  document.querySelectorAll("[data-year]").forEach(function (el) {
    el.textContent = String(new Date().getFullYear());
  });

  /* ==========================================================================
     Testimonials — hydrated from the NoSQL database (static HTML remains as
     the no-JS / offline fallback).
     ========================================================================== */
  (function () {
    var grid = document.querySelector("[data-testimonials]");
    if (!grid) return;
    apiFetch("/testimonials")
      .then(function (r) {
        if (!r.ok || !r.body.data || !r.body.data.length) return;
        grid.innerHTML = r.body.data
          .slice(0, 3)
          .map(function (t, i) {
            return (
              '<article class="quote-card reveal is-visible" style="--reveal-delay:' +
              (0.05 + i * 0.07).toFixed(2) + 's">' +
              '<div class="stars" aria-label="' + esc(t.stars) + ' out of 5 stars">' +
              "★".repeat(Math.min(5, t.stars || 5)) +
              "</div><p>" + esc(t.quote) + "</p>" +
              '<div class="quote-author"><span class="avatar" aria-hidden="true">' +
              esc(t.initials) + "</span><div><strong>" + esc(t.name) + "</strong><span>" +
              esc(t.context) + "</span></div></div></article>"
            );
          })
          .join("");
      })
      .catch(function () {
        /* keep static fallback */
      });
  })();

  /* ==========================================================================
     Insights — article reader backed by the NoSQL database
     ========================================================================== */
  (function () {
    var overlay = document.querySelector("#article-overlay");
    if (!overlay) return;
    var panel = overlay.querySelector(".article-panel");
    var closeBtn = overlay.querySelector(".article-close");

    function closeArticle() {
      overlay.classList.remove("is-open");
      document.body.style.overflow = "";
    }
    closeBtn.addEventListener("click", closeArticle);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeArticle();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && overlay.classList.contains("is-open")) closeArticle();
    });

    document.querySelectorAll("[data-article-slug]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var slug = btn.getAttribute("data-article-slug");
        overlay.classList.add("is-open");
        document.body.style.overflow = "hidden";
        panel.querySelector(".article-content").innerHTML =
          '<div class="article-loading">Retrieving article from EquitasDB…</div>';
        apiFetch("/insights/" + encodeURIComponent(slug))
          .then(function (r) {
            if (!r.ok) throw new Error(r.body.error || "Not found");
            var a = r.body.data;
            panel.querySelector(".article-content").innerHTML =
              '<div class="insight-meta"><span class="cat">' + esc(a.category) +
              "</span><time>" + formatDate(a.date) + "</time></div>" +
              "<h2>" + esc(a.title) + "</h2>" +
              '<div class="byline">By <strong>' + esc(a.author) +
              "</strong> · Equitas Law Insights</div>" +
              '<div class="article-body">' +
              (a.body || [])
                .map(function (p) {
                  return "<p>" + esc(p) + "</p>";
                })
                .join("") +
              "</div>";
          })
          .catch(function (err) {
            panel.querySelector(".article-content").innerHTML =
              '<div class="article-loading">This article could not be loaded (' +
              esc(err.message) + "). Please try again later.</div>";
          });
      });
    });
  })();

  /* ==========================================================================
     Consultation form → stored in the NoSQL database
     ========================================================================== */
  (function () {
    var form = document.querySelector("#consultation-form");
    if (!form) return;

    var status = form.querySelector(".form-status");
    var submitBtn = form.querySelector('button[type="submit"]');

    var showStatus = function (kind, message) {
      status.className =
        "form-status is-visible form-status--" + (kind === "success" ? "success" : "error");
      status.setAttribute("role", kind === "success" ? "status" : "alert");
      status.textContent = message;
      status.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };

    function clearFieldErrors() {
      form.querySelectorAll(".field.has-error").forEach(function (f) {
        f.classList.remove("has-error");
      });
      form.querySelectorAll(".error-text").forEach(function (e) {
        e.remove();
      });
    }

    function showFieldErrors(fields) {
      Object.keys(fields).forEach(function (name) {
        var input = form.elements[name];
        if (!input) return;
        var field = input.closest(".field");
        if (!field) return;
        field.classList.add("has-error");
        var note = document.createElement("span");
        note.className = "error-text";
        note.textContent = fields[name];
        field.appendChild(note);
      });
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      clearFieldErrors();

      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      var data = {
        name: form.elements.name.value.trim(),
        email: form.elements.email.value.trim(),
        phone: form.elements.phone.value.trim(),
        service: form.elements.service.value,
        message: form.elements.message.value.trim(),
        company: form.elements.company.value, // honeypot — humans leave empty
      };

      submitBtn.classList.add("btn--loading");
      submitBtn.disabled = true;
      status.className = "form-status";

      apiFetch("/consultations", { method: "POST", json: data })
        .then(function (r) {
          if (r.ok) {
            form.reset();
            showStatus(
              "success",
              "Thank you, " +
                data.name.split(" ")[0] +
                ". Your consultation request (ref. " +
                String(r.body.reference || "").slice(0, 8) +
                ") is logged in our chambers system. An advocate will contact you within one business day."
            );
          } else {
            if (r.body.fields) showFieldErrors(r.body.fields);
            showStatus(
              "error",
              r.body.error ||
                "We could not log your request just now. Please call +254 711 000 222 or email info@equitaslaw.co.ke."
            );
          }
        })
        .catch(function () {
          showStatus(
            "error",
            "Network error — your request could not reach the chambers system. Please check your connection, or call +254 711 000 222."
          );
        })
        .finally(function () {
          submitBtn.classList.remove("btn--loading");
          submitBtn.disabled = false;
        });
    });
  })();

  /* ==========================================================================
     Admin dashboard — EquitasDB console
     ========================================================================== */
  (function () {
    var shell = document.querySelector("[data-admin]");
    if (!shell) return;

    var keyForm = document.querySelector("#admin-key-form");
    var keyInput = document.querySelector("#admin-key");
    var statsGrid = document.querySelector("#admin-stats");
    var consultBody = document.querySelector("#consultations-body");
    var queryForm = document.querySelector("#query-form");
    var queryCollection = document.querySelector("#query-collection");
    var queryInput = document.querySelector("#query-input");
    var queryResult = document.querySelector("#query-result");
    var renderActiveSuite = null;

    keyInput.value = sessionStorage.getItem("equitas_admin_key") || "";

    keyForm.addEventListener("submit", function (e) {
      e.preventDefault();
      sessionStorage.setItem("equitas_admin_key", keyInput.value.trim());
      refreshAll();
    });

    function refreshAll() {
      loadStats();
      loadConsultations();
      if (renderActiveSuite) renderActiveSuite();
    }

    function loadStats() {
      apiFetch("/stats")
        .then(function (r) {
          if (!r.ok) throw new Error("no stats");
          statsGrid.innerHTML = r.body.collections
            .map(function (c) {
              return (
                '<div class="admin-stat"><strong>' + esc(c.count) + "</strong><span>" +
                esc(c.name) + " · " + (c.sizeBytes / 1024).toFixed(1) + " KB</span></div>"
              );
            })
            .join("");
        })
        .catch(function () {
          statsGrid.innerHTML =
            '<div class="admin-stat"><strong>—</strong><span>API unreachable</span></div>';
        });
    }

    function badge(status) {
      return '<span class="badge badge--' + esc(status || "new") + '">' + esc(status || "new") + "</span>";
    }

    function loadConsultations() {
      apiFetch("/consultations")
        .then(function (r) {
          if (r.status === 401) {
            consultBody.innerHTML =
              '<tr><td colspan="7"><div class="empty-state">Enter the admin key above to view consultation requests.</div></td></tr>';
            return;
          }
          var rows = r.body.data || [];
          if (!rows.length) {
            consultBody.innerHTML =
              '<tr><td colspan="7"><div class="empty-state">No consultation requests yet. New submissions from the contact form appear here in real time.</div></td></tr>';
            return;
          }
          consultBody.innerHTML = rows
            .map(function (c) {
              return (
                "<tr>" +
                "<td>" + badge(c.status) + "</td>" +
                "<td><strong>" + esc(c.name) + "</strong><br><span style='color:var(--grey-500);font-size:.82rem'>" + esc(c.email) + "</span></td>" +
                '<td class="hide-sm">' + esc(c.phone || "—") + "</td>" +
                '<td class="hide-sm">' + esc(c.service || "—") + "</td>" +
                '<td class="msg-cell hide-sm"><span title="' + esc(c.message) + '">' + esc(c.message) + "</span></td>" +
                '<td class="hide-sm">' + formatDate(c.createdAt) + "</td>" +
                '<td><div class="row-actions">' +
                '<button class="icon-btn" title="Mark contacted" data-status="contacted" data-id="' + esc(c._id) + '">☎</button>' +
                '<button class="icon-btn" title="Mark scheduled" data-status="scheduled" data-id="' + esc(c._id) + '">✔</button>' +
                '<button class="icon-btn icon-btn--danger" title="Delete" data-delete="' + esc(c._id) + '">✕</button>' +
                "</div></td></tr>"
              );
            })
            .join("");
        })
        .catch(function () {
          consultBody.innerHTML =
            '<tr><td colspan="7"><div class="empty-state">Could not reach the database API.</div></td></tr>';
        });
    }

    consultBody.addEventListener("click", function (e) {
      var statusBtn = e.target.closest("[data-status]");
      var deleteBtn = e.target.closest("[data-delete]");
      if (statusBtn) {
        apiFetch("/consultations/" + statusBtn.getAttribute("data-id"), {
          method: "PATCH",
          json: { status: statusBtn.getAttribute("data-status") },
        }).then(loadConsultations);
      } else if (deleteBtn) {
        if (!confirm("Delete this consultation request from EquitasDB?")) return;
        apiFetch("/consultations/" + deleteBtn.getAttribute("data-delete"), {
          method: "DELETE",
        }).then(loadConsultations);
      }
    });

    queryForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var query;
      try {
        query = JSON.parse(queryInput.value || "{}");
      } catch (err) {
        queryResult.textContent = "Invalid JSON: " + err.message;
        return;
      }
      queryResult.textContent = "Running query against EquitasDB…";
      apiFetch("/query", {
        method: "POST",
        json: { collection: queryCollection.value, query: query, limit: 50 },
      }).then(function (r) {
        queryResult.textContent = JSON.stringify(r.body, null, 2);
      });
    });

    /* ---------------------------- mail panel ------------------------------ */
    var mailStatus = document.querySelector("#mail-status");
    var mailBoxSelect = document.querySelector("#mail-box-select");
    var mailBody = document.querySelector("#mail-body");
    var mailOverlay = document.querySelector("#mail-overlay");
    var composeOverlay = document.querySelector("#compose-overlay");
    var composeForm = document.querySelector("#compose-form");

    function bindOverlay(overlay) {
      if (!overlay) return;
      overlay.querySelector(".article-close").addEventListener("click", function () {
        overlay.classList.remove("is-open");
        document.body.style.overflow = "";
      });
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) {
          overlay.classList.remove("is-open");
          document.body.style.overflow = "";
        }
      });
    }
    bindOverlay(mailOverlay);
    bindOverlay(composeOverlay);

    function loadMailStatus() {
      apiFetch("/mail/status").then(function (r) {
        if (!r.ok) {
          mailStatus.textContent = "SMTP status unavailable.";
          return;
        }
        var s = r.body.smtp || {};
        mailStatus.textContent = s.running
          ? "SMTP live on port " + s.port + " · domains: " + (s.domains || []).join(", ") +
            " · received: " + (s.messagesReceived || 0)
          : "Serverless mode — local mailbox delivery only (no TCP listener).";
      }).catch(function () {
        mailStatus.textContent = "SMTP status unavailable.";
      });
    }

    function loadMailboxes() {
      apiFetch("/mail/mailboxes").then(function (r) {
        if (!r.ok || !r.body.data) return;
        var current = mailBoxSelect.value || "d.i.majanja@equitaslaw.org";
        mailBoxSelect.innerHTML = r.body.data
          .map(function (b) {
            return (
              '<option value="' + esc(b.address) + '"' +
              (b.address === current ? " selected" : "") + ">" +
              esc(b.address) + " (" + b.unread + " unread)</option>"
            );
          })
          .join("");
        if (!mailBoxSelect.value) mailBoxSelect.value = "d.i.majanja@equitaslaw.org";
        loadInbox();
      });
    }

    function loadInbox() {
      var box = mailBoxSelect.value || "d.i.majanja@equitaslaw.org";
      apiFetch("/mail/inbox/" + encodeURIComponent(box)).then(function (r) {
        if (r.status === 401) {
          mailBody.innerHTML = '<tr><td colspan="6"><div class="empty-state">Enter the admin key above to open the mailbox.</div></td></tr>';
          return;
        }
        var rows = (r.body && r.body.data) || [];
        if (!rows.length) {
          mailBody.innerHTML = '<tr><td colspan="6"><div class="empty-state">Mailbox is empty. Send a message via SMTP to port 2525, or use Compose.</div></td></tr>';
          return;
        }
        mailBody.innerHTML = rows
          .map(function (m) {
            return (
              '<tr class="' + (m.read ? "" : "mail-unread") + '">' +
              "<td>" + (m.read ? "" : '<span class="badge badge--new">new</span>') + "</td>" +
              "<td>" + esc(m.from) + "</td>" +
              "<td>" + esc(m.subject) + "</td>" +
              '<td class="hide-sm">' + formatDate(m.date) + "</td>" +
              '<td class="hide-sm">' + (m.direction === "out" ? "sent" : "in") + "</td>" +
              '<td><div class="row-actions">' +
              '<button class="icon-btn" title="Read" data-read-mail="' + esc(m._id) + '">✉</button>' +
              '<button class="icon-btn icon-btn--danger" title="Delete" data-del-mail="' + esc(m._id) + '">✕</button>' +
              "</div></td></tr>"
            );
          })
          .join("");
      }).catch(function () {
        mailBody.innerHTML = '<tr><td colspan="6"><div class="empty-state">Could not reach the mail API.</div></td></tr>';
      });
    }

    mailBody.addEventListener("click", function (e) {
      var readBtn = e.target.closest("[data-read-mail]");
      var delBtn = e.target.closest("[data-del-mail]");
      if (readBtn) {
        apiFetch("/mail/message/" + readBtn.getAttribute("data-read-mail")).then(function (r) {
          if (!r.ok) return;
          var m = r.body.data;
          mailOverlay.querySelector(".mail-message-content").innerHTML =
            '<div class="insight-meta"><span class="cat">' + (m.direction === "out" ? "Sent" : "Inbox") +
            "</span><time>" + formatDate(m.date) + "</time></div>" +
            "<h2>" + esc(m.subject) + "</h2>" +
            '<div class="byline">From <strong>' + esc(m.from) + "</strong> · To " + esc((m.to || []).join(", ")) +
            " · " + (m.size / 1024).toFixed(1) + " KB</div>" +
            '<div class="article-body"><p style="white-space:pre-wrap">' + esc(m.text) + "</p></div>";
          mailOverlay.classList.add("is-open");
          document.body.style.overflow = "hidden";
          loadInbox();
          loadMailboxes();
        });
      } else if (delBtn) {
        if (!confirm("Delete this message from the mailbox?")) return;
        apiFetch("/mail/message/" + delBtn.getAttribute("data-del-mail"), { method: "DELETE" })
          .then(function () { loadInbox(); loadMailboxes(); loadStats(); });
      }
    });

    mailBoxSelect.addEventListener("change", loadInbox);
    document.querySelector("#mail-refresh").addEventListener("click", function () {
      loadMailStatus();
      loadMailboxes();
    });
    document.querySelector("#mail-compose-open").addEventListener("click", function () {
      composeOverlay.classList.add("is-open");
      document.body.style.overflow = "hidden";
    });

    composeForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var status = composeForm.querySelector(".form-status");
      var btn = composeForm.querySelector('button[type="submit"]');
      btn.classList.add("btn--loading");
      btn.disabled = true;
      apiFetch("/mail/send", {
        method: "POST",
        json: {
          from: composeForm.elements.from.value,
          to: composeForm.elements.to.value.trim(),
          subject: composeForm.elements.subject.value,
          text: composeForm.elements.text.value,
        },
      }).then(function (r) {
        status.className = "form-status is-visible form-status--" + (r.ok ? "success" : "error");
        status.textContent = r.ok
          ? "Delivered (" + r.body.delivered + ") to " + r.body.to
          : r.body.error || "Send failed.";
        if (r.ok) {
          composeForm.elements.to.value = "";
          composeForm.elements.subject.value = "";
          composeForm.elements.text.value = "";
          loadInbox();
          loadMailboxes();
          loadStats();
        }
      }).finally(function () {
        btn.classList.remove("btn--loading");
        btn.disabled = false;
      });
    });

    loadMailStatus();
    loadMailboxes();

    /* ==========================================================================
       Business suite — ERP · CRM · POS · M-Pesa
       ========================================================================== */
    var suitePanel = document.querySelector("#suite-panel");
    if (suitePanel) {
      var suiteView = document.querySelector("#suite-view");
      var suiteStatus = document.querySelector("#suite-status");
      var suiteTabs = Array.prototype.slice.call(suitePanel.querySelectorAll("[data-suite-tab]"));
      var activeSuiteTab = "dashboard";
      var suiteCache = { clients: [], invoices: [] };

      var money = function (n) {
        return "KES " + (Number(n) || 0).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      };
      var badgeHtml = function (s) {
        var ok = /^(paid|met|verified|reconciled|issued|open|submitted|accepted|ok|active)$/i.test(String(s || ""));
        return '<span class="' + (ok ? "pill-ok" : "pill-warn") + '">' + esc(s || "—") + "</span>";
      };
      var card = function (label, value) {
        return '<div class="kpi"><strong>' + esc(value) + "</strong><span>" + esc(label) + "</span></div>";
      };
      var table = function (cols, rows) {
        if (!rows.length) return '<div class="empty-state">Nothing here yet.</div>';
        return (
          '<div style="overflow-x:auto"><table class="admin-table"><thead><tr>' +
          cols.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") +
          "</tr></thead><tbody>" +
          rows.map(function (r) {
            return "<tr>" + r.map(function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>";
          }).join("") +
          "</tbody></table></div>"
        );
      };
      var clientOptions = function () {
        return (
          '<option value="">— select client —</option>' +
          suiteCache.clients.map(function (c) {
            return '<option value="' + esc(c._id) + '">' + esc(c.name) + "</option>";
          }).join("")
        );
      };
      var setView = function (html) { suiteView.innerHTML = html; };
      var busy = function () { suiteStatus.textContent = "Loading…"; };
      var ready = function () { suiteStatus.textContent = "Live · " + new Date().toLocaleTimeString("en-KE"); };
      var warn = function () { setView('<div class="empty-state">Enter the admin key above to load the business suite.</div>'); };

      var renders = {
        dashboard: function () {
          return Promise.all([apiFetch("/crm/dashboard"), apiFetch("/erp/reports/compliance")]).then(function (r) {
            if (!r[0].ok) return warn();
            var d = r[0].body.data;
            setView(
              '<div class="kpi-grid">' +
                card("Clients", d.clients) + card("Active matters", d.activeMatters) +
                card("Open invoices", d.openInvoices) + card("Receivables", money(d.receivables)) +
                card("Fee income", money(d.feeIncome)) + card("Collected", money(d.collected)) +
                card("Trust balance", money(d.trustBalance)) + card("Today's takings", money(d.todayTakings)) +
                "</div>" +
              '<h3 style="margin:.4rem 0 .8rem">Kenyan compliance</h3>' +
              '<ul class="compliance-list">' +
              (r[1].ok
                ? r[1].body.data.statutes.map(function (s) {
                    return '<li><span><strong>' + esc(s.act) + "</strong> — " + esc(s.requirement) + "</span>" + badgeHtml(s.met ? "met" : "action") + "</li>";
                  }).join("")
                : "") +
              "</ul>"
            );
          });
        },
        clients: function () {
          return apiFetch("/crm/clients").then(function (r) {
            if (!r.ok) return warn();
            suiteCache.clients = r.body.data || [];
            var rows = suiteCache.clients.map(function (c) {
              return [
                esc(c.name),
                esc(c.email || "—"),
                badgeHtml(c.kycStatus || "pending"),
                c.riskAssessment ? badgeHtml(c.riskAssessment.rating) : "—",
                '<button class="btn btn--outline-navy" style="padding:.35rem .9rem" data-suite-act="kyc" data-id="' + esc(c._id) + '">Verify KYC</button> ' +
                  '<button class="btn btn--outline-navy" style="padding:.35rem .9rem" data-suite-act="statement" data-id="' + esc(c._id) + '">Statement</button>',
              ];
            });
            setView(
              '<form class="suite-form" data-suite-form="client">' +
                '<input name="name" placeholder="Full name / company" required>' +
                '<input name="email" type="email" placeholder="Email">' +
                '<input name="phone" placeholder="Phone">' +
                '<select name="type"><option value="individual">Individual</option><option value="company">Company</option></select>' +
                '<input name="pin" placeholder="KRA PIN">' +
                '<div class="suite-form-full"><button class="btn btn--navy" type="submit">Add client</button></div>' +
              "</form>" +
              table(["Name", "Email", "KYC", "Risk", "Actions"], rows) +
              '<div id="suite-detail"></div>'
            );
          });
        },
        matters: function () {
          return Promise.all([apiFetch("/erp/matters"), apiFetch("/crm/clients")]).then(function (r) {
            if (!r[0].ok) return warn();
            var matters = r[0].body.data || [];
            suiteCache.clients = r[1].body.data || [];
            var cname = function (id) {
              var c = suiteCache.clients.filter(function (x) { return x._id === id; })[0];
              return c ? c.name : "—";
            };
            var rows = matters.map(function (m) {
              return [esc(m.matterNumber), esc(m.title), esc(cname(m.clientId)), esc(m.practiceArea), badgeHtml(m.status), esc(m.advocate)];
            });
            setView(
              '<form class="suite-form" data-suite-form="matter">' +
                '<select name="clientId" required>' + clientOptions() + "</select>" +
                '<input name="title" placeholder="Matter title" required>' +
                '<input name="practiceArea" placeholder="Practice area">' +
                '<input name="advocate" placeholder="Advocate">' +
                '<select name="feeArrangement"><option value="hourly">Hourly</option><option value="fixed">Fixed</option><option value="retainer">Retainer</option><option value="contingency">Contingency</option></select>' +
                '<div class="suite-form-full"><button class="btn btn--navy" type="submit">Open matter</button></div>' +
              "</form>" +
              table(["No.", "Title", "Client", "Area", "Status", "Advocate"], rows)
            );
          });
        },
        invoices: function () {
          return Promise.all([apiFetch("/erp/invoices"), apiFetch("/crm/clients")]).then(function (r) {
            if (!r[0].ok) return warn();
            suiteCache.invoices = r[0].body.data || [];
            suiteCache.clients = r[1].body.data || [];
            var cname = function (id) {
              var c = suiteCache.clients.filter(function (x) { return x._id === id; })[0];
              return c ? c.name : "—";
            };
            var rows = suiteCache.invoices.map(function (inv) {
              var acts = "";
              if (inv.status === "draft") {
                acts += '<button class="btn btn--outline-navy" style="padding:.35rem .9rem" data-suite-act="issue" data-id="' + esc(inv._id) + '">Issue</button>';
              } else {
                acts +=
                  '<button class="btn btn--outline-navy" style="padding:.35rem .9rem" data-suite-act="etims" data-id="' + esc(inv._id) + '">eTIMS</button> ' +
                  '<button class="btn btn--outline-navy" style="padding:.35rem .9rem" data-suite-act="stk" data-id="' + esc(inv._id) + '">STK push</button>';
              }
              return [esc(inv.invoiceNumber || "(draft)"), esc(cname(inv.clientId)), money(inv.total), money(inv.balance), badgeHtml(inv.status), acts];
            });
            setView(
              '<form class="suite-form" data-suite-form="invoice">' +
                '<select name="clientId" required>' + clientOptions() + "</select>" +
                '<input name="description" placeholder="Description" required>' +
                '<input name="unitPrice" type="number" min="0" step="0.01" placeholder="Unit price" required>' +
                '<input name="quantity" type="number" min="1" step="1" placeholder="Qty" value="1">' +
                '<div class="suite-form-full"><button class="btn btn--navy" type="submit">Create draft</button></div>' +
              "</form>" +
              table(["Invoice #", "Client", "Total", "Balance", "Status", "Actions"], rows)
            );
          });
        },
        pos: function () {
          return Promise.all([apiFetch("/pos/takings"), apiFetch("/pos/payments")]).then(function (r) {
            if (!r[0].ok) return warn();
            var t = r[0].body.data;
            var methodCards = Object.keys(t.byMethod).map(function (m) { return card(m, money(t.byMethod[m])); }).join("");
            var payments = (r[1].body.data || []).slice(0, 20).map(function (p) {
              return [esc(p.receiptNumber || p.reference || "—"), esc(p.method), money(p.amount), esc(formatDate(p.createdAt || p.date))];
            });
            setView(
              '<div class="kpi-grid">' + card("Takings today", money(t.total)) + card("Transactions", t.count) + methodCards + "</div>" +
              '<form class="suite-form" data-suite-form="sale">' +
                '<input name="clientName" placeholder="Walk-in name" required>' +
                '<input name="description" placeholder="Sale description">' +
                '<input name="amount" type="number" min="0" step="0.01" placeholder="Amount (KES, VAT-incl.)" required>' +
                '<select name="method"><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="card">Card</option><option value="cheque">Cheque</option></select>' +
                '<div class="suite-form-full"><button class="btn btn--navy" type="submit">Record sale</button></div>' +
              "</form>" +
              table(["Receipt", "Method", "Amount", "Date"], payments)
            );
          });
        },
        trust: function () {
          return Promise.all([apiFetch("/erp/trust/reconciliation"), apiFetch("/crm/clients")]).then(function (r) {
            if (!r[0].ok) return warn();
            var t = r[0].body.data;
            suiteCache.clients = r[1].body.data || [];
            var cname = function (id) {
              var c = suiteCache.clients.filter(function (x) { return x._id === id; })[0];
              return c ? c.name : id;
            };
            var rows = Object.keys(t.byClient).map(function (id) {
              return [esc(cname(id)), money(t.byClient[id]), t.byClient[id] < 0 ? badgeHtml("overdrawn") : badgeHtml("ok")];
            });
            setView(
              '<div class="kpi-grid">' + card("Total held", money(t.total)) + card("Clients", t.clients) + card("Overdrawn", t.overdrawn) + "</div>" +
              '<form class="suite-form" data-suite-form="trust">' +
                '<select name="clientId" required>' + clientOptions() + "</select>" +
                '<select name="kind"><option value="deposit">Deposit</option><option value="withdraw">Withdraw</option><option value="transfer">Transfer to office</option></select>' +
                '<input name="amount" type="number" min="0" step="0.01" placeholder="Amount" required>' +
                '<input name="description" placeholder="Purpose / reference">' +
                '<div class="suite-form-full"><button class="btn btn--navy" type="submit">Post entry</button></div>' +
              "</form>" +
              table(["Client", "Balance", "Status"], rows)
            );
          });
        },
        mpesa: function () {
          return Promise.all([apiFetch("/mpos/status"), apiFetch("/mpos/transactions"), apiFetch("/erp/invoices")]).then(function (r) {
            var status = (r[0].body && r[0].body.data) || {};
            suiteCache.invoices = (r[2].body && r[2].body.data) || [];
            var txns = (r[1].body && r[1].body.data) || [];
            var invOpts =
              '<option value="">— invoice —</option>' +
              suiteCache.invoices.map(function (i) {
                return '<option value="' + esc(i._id) + '">' + esc(i.invoiceNumber || "(draft)") + " · " + money(i.balance) + "</option>";
              }).join("");
            var rows = txns.map(function (t) {
              var link =
                t.status === "unmatched"
                  ? '<select data-link-tx="' + esc(t._id) + '" style="max-width:220px">' + invOpts + "</select> " +
                    '<button class="btn btn--outline-navy" style="padding:.3rem .8rem" data-suite-act="link" data-id="' + esc(t._id) + '">Link</button>'
                  : badgeHtml(t.status);
              return [esc(t.receipt || "—"), esc(t.accountReference || "—"), money(t.amount), esc(t.phone || "—"), esc(t.channel), link];
            });
            setView(
              '<div class="kpi-grid">' +
                card("Environment", status.env || "—") +
                card("Credentials", status.hasCredentials ? "✓" : "✗") +
                card("Callback", status.hasCallback ? "✓" : "✗") +
                "</div>" +
              '<div class="suite-actions">' +
                '<button class="btn btn--outline-navy" data-suite-act="c2b-register">Register C2B URLs</button>' +
                '<button class="btn btn--outline-navy" data-suite-act="balance">Account balance</button>' +
                '<button class="btn btn--outline-navy" data-suite-act="qr">Dynamic QR</button>' +
                "</div>" +
              '<form class="suite-form" data-suite-form="mpesa-stk">' +
                '<input name="phone" placeholder="Phone (07…)" required>' +
                '<input name="amount" type="number" min="1" step="1" placeholder="Amount" required>' +
                '<input name="accountReference" placeholder="Account reference">' +
                '<div class="suite-form-full"><button class="btn btn--navy" type="submit">STK Push</button></div>' +
              "</form>" +
              '<h3 style="margin:.4rem 0 .8rem">Transactions</h3>' +
              table(["Receipt", "Reference", "Amount", "Phone", "Channel", "Status"], rows) +
              '<div id="suite-detail"></div>'
            );
          });
        },
        reports: function () {
          var names = ["dashboard", "trial-balance", "aged-debtors", "vat", "wht", "revenue", "receivables", "compliance"];
          setView(
            '<div class="suite-actions">' +
              names.map(function (n) {
                return '<button class="btn btn--outline-navy" data-suite-act="report" data-report="' + n + '">' + esc(n) + "</button>";
              }).join("") +
              "</div>" +
            '<pre id="suite-detail" class="query-result" style="margin-top:1rem;max-height:420px;overflow:auto">Select a report…</pre>'
          );
          return Promise.resolve();
        },
      };

      function loadTab(tab) {
        activeSuiteTab = tab;
        suiteTabs.forEach(function (b) {
          b.classList.toggle("is-active", b.getAttribute("data-suite-tab") === tab);
        });
        busy();
        Promise.resolve(renders[tab] ? renders[tab]() : null)
          .then(ready)
          .catch(function (e) {
            setView('<div class="empty-state">' + esc(e && e.message ? e.message : "Failed to load suite.") + "</div>");
          });
      }

      suiteTabs.forEach(function (b) {
        b.addEventListener("click", function () { loadTab(b.getAttribute("data-suite-tab")); });
      });

      suiteView.addEventListener("submit", function (e) {
        var form = e.target.closest("form[data-suite-form]");
        if (!form) return;
        e.preventDefault();
        var kind = form.getAttribute("data-suite-form");
        var data = {};
        Array.prototype.forEach.call(form.elements, function (el) {
          if (el.name) data[el.name] = el.value;
        });
        var req;
        if (kind === "client") req = apiFetch("/crm/clients", { method: "POST", json: data });
        else if (kind === "matter") req = apiFetch("/erp/matters", { method: "POST", json: data });
        else if (kind === "invoice")
          req = apiFetch("/erp/invoices", {
            method: "POST",
            json: {
              clientId: data.clientId,
              lines: [{ description: data.description, quantity: Number(data.quantity) || 1, unitPrice: Number(data.unitPrice) || 0 }],
            },
          });
        else if (kind === "sale")
          req = apiFetch("/pos/payments", {
            method: "POST",
            json: { clientName: data.clientName, description: data.description, amount: Number(data.amount), method: data.method },
          });
        else if (kind === "trust")
          req = apiFetch("/erp/trust/" + data.kind, {
            method: "POST",
            json: { clientId: data.clientId, amount: Number(data.amount), description: data.description },
          });
        else if (kind === "mpesa-stk")
          req = apiFetch("/mpos/stkpush", {
            method: "POST",
            json: { phone: data.phone, amount: Number(data.amount), accountReference: data.accountReference },
          });
        if (!req) return;
        req.then(function (r) {
          if (!r.ok) { alert(r.body.error || "Request failed."); return; }
          loadTab(activeSuiteTab);
          loadStats();
        });
      });

      suiteView.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-suite-act]");
        if (!btn) return;
        var act = btn.getAttribute("data-suite-act");
        var id = btn.getAttribute("data-id");
        var detail = function (obj) {
          var el = document.querySelector("#suite-detail");
          if (el) el.textContent = JSON.stringify(obj, null, 2);
        };
        if (act === "kyc") {
          apiFetch("/crm/clients/" + id + "/kyc", {
            method: "POST",
            json: { status: "verified", documents: [{ name: "National ID", reference: "on-file" }] },
          }).then(function () { loadTab("clients"); loadStats(); });
        } else if (act === "statement") {
          apiFetch("/crm/clients/" + id + "/statement").then(function (r) { detail(r.body.data); });
        } else if (act === "issue") {
          apiFetch("/erp/invoices/" + id + "/issue", { method: "POST" }).then(function () { loadTab("invoices"); loadStats(); });
        } else if (act === "etims") {
          apiFetch("/erp/invoices/" + id + "/etims", { method: "POST" }).then(function (r) { alert(JSON.stringify(r.body.data || r.body)); });
        } else if (act === "stk") {
          var phone = prompt("Phone number (07…):");
          if (phone) {
            apiFetch("/mpos/stkpush", { method: "POST", json: { invoiceId: id, phone: phone } }).then(function (r) {
              alert(r.ok ? "STK Push sent to " + phone : (r.body.error || "Failed."));
            });
          }
        } else if (act === "link") {
          var sel = document.querySelector('[data-link-tx="' + id + '"]');
          if (sel && sel.value) {
            apiFetch("/mpos/transactions/" + id + "/link", { method: "POST", json: { invoiceId: sel.value } }).then(function () {
              loadTab("mpesa");
              loadStats();
            });
          } else { alert("Choose an invoice to link."); }
        } else if (act === "c2b-register") {
          apiFetch("/mpos/c2b/register", { method: "POST", json: {} }).then(function (r) { alert(JSON.stringify(r.body.data || r.body)); });
        } else if (act === "balance") {
          apiFetch("/mpos/balance", { method: "POST", json: {} }).then(function (r) { alert(JSON.stringify(r.body.data || r.body)); });
        } else if (act === "qr") {
          apiFetch("/mpos/qr", { method: "POST", json: {} }).then(function (r) {
            var el = document.querySelector("#suite-detail");
            var b64 = r.body && r.body.data && r.body.data.qrCode;
            if (el && b64) {
              el.innerHTML = '<div class="qr-box"><img alt="M-Pesa QR" src="data:image/png;base64,' + b64 + '"></div>';
            } else { detail(r.body.data || r.body); }
          });
        } else if (act === "report") {
          apiFetch("/erp/reports/" + btn.getAttribute("data-report")).then(function (r) { detail(r.body.data); });
        }
      });

      renderActiveSuite = function () {
        if (sessionStorage.getItem("equitas_admin_key")) loadTab(activeSuiteTab);
      };
      if (sessionStorage.getItem("equitas_admin_key")) loadTab(activeSuiteTab);
    }

    refreshAll();
  })();
})();
