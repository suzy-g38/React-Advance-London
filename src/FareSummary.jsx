export function FareSummary({ fare }) {
  return (
    <section className="fare-summary" aria-labelledby="fare-heading">
      <h3 id="fare-heading">Your fare</h3>
      <p className="fare-summary__price">£{fare.total}</p>
      <div className="fare-summary__status">
        Free cancellation up to 24 hours before departure.
      </div>
    </section>
  );
}
