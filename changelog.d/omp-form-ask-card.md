### Fixed
- omp 19's Ask form (one HTML form per question set) shows as a card again instead of a terminal
  mirror with Enter and Esc: each field is answered in turn (choices, checkboxes, dropdowns and
  typed answers), with the form's fields as steps and a review before Submit.
- On a phone, where omp's form box scrolls, a choice whose options run past the box no longer shows
  as a card with only the options on screen: a radio group is filled in from the agent's form, and
  otherwise the card says more options are listed in the terminal.
- On a phone, a question's context is no longer squeezed to a line when its options are long: it
  keeps its own height, up to ten lines, and the card scrolls as a whole.
- A question's card may take up to 80% of the screen (approvals and plans keep 60%), so a
  question with long options scrolls less or not at all.
