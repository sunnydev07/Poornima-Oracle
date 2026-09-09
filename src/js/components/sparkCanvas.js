/**
 * Poornima Oracle - ClickSpark Canvas Animation
 */
export class ClickSpark {
    constructor() {
        this.canvas = document.getElementById('click-spark-canvas');
        this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
        this.sparks = [];
        this.sparkColor = '#fff';
        this.sparkSize = 10;
        this.sparkRadius = 15;
        this.sparkCount = 8;
        this.duration = 400;
        this.animating = false;
        if (this.canvas) {
            this.resize();
            this.initEvents();
        }
    }

    initEvents() {
        window.addEventListener('resize', () => this.resize());
        window.addEventListener('click', (e) => this.addSparks(e));
        window.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            if (touch) {
                this.addSparks({ clientX: touch.clientX, clientY: touch.clientY });
            }
        }, { passive: true });
    }

    resize() {
        if (!this.canvas) return;
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    easeOut(t) {
        return t * (2 - t);
    }

    addSparks(e) {
        const now = performance.now();
        for (let i = 0; i < this.sparkCount; i++) {
            this.sparks.push({
                x: e.clientX,
                y: e.clientY,
                angle: (2 * Math.PI * i) / this.sparkCount,
                startTime: now,
            });
        }
        if (!this.animating) {
            this.animating = true;
            requestAnimationFrame((t) => this.animate(t));
        }
    }

    animate(timestamp) {
        if (!this.ctx) return;
        if (!timestamp) timestamp = performance.now();
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.sparks = this.sparks.filter((spark) => {
            const elapsed = timestamp - spark.startTime;
            if (elapsed >= this.duration) return false;
            const progress = elapsed / this.duration;
            const eased = this.easeOut(progress);
            const distance = eased * this.sparkRadius;
            const lineLength = this.sparkSize * (1 - eased);
            const x1 = spark.x + distance * Math.cos(spark.angle);
            const y1 = spark.y + distance * Math.sin(spark.angle);
            const x2 = spark.x + (distance + lineLength) * Math.cos(spark.angle);
            const y2 = spark.y + (distance + lineLength) * Math.sin(spark.angle);
            this.ctx.strokeStyle = this.sparkColor;
            this.ctx.lineWidth = 2;
            this.ctx.beginPath();
            this.ctx.moveTo(x1, y1);
            this.ctx.lineTo(x2, y2);
            this.ctx.stroke();
            return true;
        });
        if (this.sparks.length > 0) {
            requestAnimationFrame((t) => this.animate(t));
        } else {
            this.animating = false;
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
    }
}
