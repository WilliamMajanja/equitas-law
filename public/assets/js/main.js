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

    keyInput.value = sessionStorage.getItem("equitas_admin_key") || "";

    keyForm.addEventListener("submit", function (e) {
      e.preventDefault();
      sessionStorage.setItem("equitas_admin_key", keyInput.value.trim());
      refreshAll();
    });

    function refreshAll() {
      loadStats();
      loadConsultations();
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

    refreshAll();
  })();
})();
